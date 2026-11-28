# In-app notices and bill markers

## The idea
A **notification** reaches you even when the app is closed (push). An **in-app notice** only shows while you're using the app. SplitIt has no push yet (that needs a paid Apple account, a push service and a backend decision), so it tells you about new things the cheap, reliable way: the next time Home loads, it shows what changed. *(Since 2026-11-27 there is one **local** notification: Sam's own phone asks "Did your $15.10 to Hana go through?" a minute after he opens Venmo. Nobody else is notified. See [local notifications](local-notifications.md).)*

A **marker** is a small word on a list row that says "this one needs you", like an unread dot in a mail app, but always written as a word so it doesn't rely on colour.

## Why it matters here
When a host adds you to a bill, you didn't do anything, so you have no reason to look. Without a notice, you'd find the bill by accident, or never. And a bill can't settle until every item is claimed, so a friend who never notices holds everyone up.

## How we use it
Spec: `docs/specs/2026-11-24-bill-markers-and-notices.md`. Code: `lib/homeMarkers.ts` (the rules and all copy), `components/AddedNotice.tsx` (the card), `app/(app)/index.tsx` (Home).

**Markers, one per row, first match wins** (`billMarker`):
1. Your own bill (you're the host): no marker, ever. *(Changed 2026-11-25: the host now skips only rules 2 and 3 and can get a settle marker, rule 4 below. Without settle data, the host still gets none.)*
2. **"New"**: the host added you, and you haven't opened the bill or dismissed the notice.
3. **"Nothing claimed yet"**: you're not the payer, you've claimed nothing, and the bill still has unclaimed items. Once every item is claimed it disappears, so it can never contradict the Settle screen's "You owe" or "nothing to pay".
4. *(Added 2026-11-25.)* **A settle marker**, when Home has loaded the bill's settle data. See "Home settle markers" below.
5. Otherwise: no marker.

**The card** (`addedNotice`) lists the same bills as "New": "Hana added you to a bill · Nov 20 · $44.80" with Open and Dismiss, or "You were added to 2 bills" with Dismiss. Dismiss marks those bills seen. It's a card, not a pop-up, so it never interrupts anything.

**When it updates:** Home reloads when it comes into view and when the app returns to the foreground (on web, when you switch back to the tab). It doesn't listen live, so if you're staring at Home when you're added, you see it on your next switch. See [realtime](realtime.md), "Home doesn't use Realtime".

**No read receipts:** "seen" lives in its own private table, `bill_seen`, that only you can affect, through `mark_bill_seen` and `my_bills`. Opening a bill sends no broadcast and writes no Activity, so the host can't tell when you looked. See [row-level security](row-level-security.md), "Read state is owner-only".

### Home settle markers (2026-11-25)
*From spec `docs/specs/2026-11-25-settle-early-and-differences.md` (D7, decisions HM-1 to HM-6) and [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md).*

The user asked for Home's "Your bills" to say where each bill stands without opening it. So a row can now carry one of these pills (`billMarkerView` in `lib/homeMarkers.ts`):

*(Note 2026-11-26: Home's list was split into "Waiting on you" and "Recent", with the section worked out from the pill. Superseded on 2026-11-27, see the next note.)*

*(Note 2026-11-27, Home groups v2, `docs/specs/2026-11-26-home-groups-v2.md`.)* **Pills now decide only the label, never the group.** Home's groups (Waiting on you, Owed to you, Settled, hidden) come from your balance on the bill's settle plan: do you owe anyone, and does anyone owe you? Pills don't decide them (`homeGroup` in `lib/homeSections.ts`). The pill and the group read the same plan, and `MARKER_GROUPS` lists the groups each pill may appear in, so tests can prove they agree. Two pills behave in ways worth knowing:
- **`sent` and Settled.** The Sent-via-Venmo pill ("Sam sent you $15.10") shows only while someone still owes the payer, so it only ever appears in Owed to you. When the last person pays, nobody owes the payer anything, and the bill moves to Settled at once, even if the payer hasn't seen that send yet. The marker becomes `settled`, and the "Sam sent you…" news is in the bill's Activity, not on Home (user rule 7).
- **Settled rows show no pill.** Inside the opened Settled group the "Settled up" pill isn't drawn, because the toggle already says it. The row's screen-reader label still ends with "Settled up, everyone has settled up with you".

See [design system](design-system.md), section 10.

| You are | When | Pill | Colour |
|---|---|---|---|
| someone who owes | you can pay (the bill is complete, or it's an early proportional bill and you've claimed an item) and haven't marked "I paid" | `You owe $15.10` | teal (accent) |
| someone who owes | you've marked "I paid", and there's nothing more to settle yet | `Paid $15.10` | grey (muted) |
| someone who owes | the bill is complete and your share went up after you paid | `Paid · $1.10 more to pay` | teal |
| someone who owes | the bill is complete and your share went down after you paid | `Paid · $1.10 back to you` | grey |
| the payer | the bill is complete and someone who owes hasn't marked "I paid" | `1 person left to pay` / `2 people left to pay` | grey |
| the payer | everyone who owes has marked, but there are differences | `1 difference to settle` / `2 differences to settle` | teal |
| the payer | everyone has paid and there are no differences | `Settled up` | grey |

Nobody else gets a settle pill: people who owe nothing, blocked bills, the all-$0 case, and the payer before the bill is complete (even if people are paying early). Before everyone has claimed, "left to pay" would count people who don't know their share yet (HM-4). *(Note 2026-11-27: the payer's early bill can now show the `sent` pill, "Sam sent you $15.10", while someone still owes; `settleCandidateIds` no longer skips those bills. "Left to pay" still waits for a complete bill. See "Sent via Venmo" below.)*

**Two colours only** (SE-VIS-1). Teal means "your move" (`You owe`, `more to pay`, `differences to settle`, like `New`). Everything else is grey. Done bills should be the quietest rows. Every pill says its meaning in words, so colour is never the only signal, and the words go into the row's screen-reader label too.

**No check icon on "Paid" and "Settled up".** The user decided this on 2026-11-25 (Q-GLYPH): the words already say "done", and Home stays calm. The pill logic still returns `icon: 'check'` for those two, but `MarkerPill` in `app/(app)/index.tsx` doesn't draw it. Changing your mind is a one-line change there.

**Where the numbers come from** (HM-1). "You owe $15.10" needs the real split math (`computeShares`): zero and negative shares, discounts, even mode. Two other designs were rejected:
- counting in SQL inside `my_bills`: that would be a second copy of the split math, in a different language, which would drift;
- calling `fetchBill` once per bill: up to 80 requests every time Home loads.

Instead, Home reads the rows it needs for several bills at once. After `my_bills` loads, `settleCandidateIds` picks only the bills that could show a settle pill (not `New`, not `Nothing claimed yet`, not a bill where you're the payer and it isn't complete), at most 20. Then `fetchSettleData` in `lib/bills.ts` makes **4 requests** (bills, line items, participants, claims), using the same column lists and parsers as `fetchBill`. For each bill, Home builds the same plan the Settle screen uses (`settleViewInputFor(...).plan`), and `billMarker` reads that plan. So the pill and the Settle screen can't disagree: a test checks that for every Settle card there's exactly the matching pill (criterion 67 in `lib/settleView.test.ts`).

**Privacy** (HM-6): nothing new. RLS already lets you read every one of these rows (the bill screen reads the same ones), and everyone on a bill can already see who has paid.

**The truncation guard.** PostgREST, the part of Supabase that answers these requests, stops a response at a fixed number of rows (`max_rows`, 1000 in our local `supabase/config.toml`) **without an error**. A list cut short could drop someone's claim and show a wrong "You owe $X". So each request:
- asks only for rows 0 to 999;
- asks for an exact count of matching rows too, and fails if it got fewer rows than the count, or no count. This catches a lower `max_rows` on the hosted project as well (review R7);
- fails if it got 1,000 rows or more.

If any request fails, Home shows no settle pills at all (`New` and `Nothing claimed yet` still work). A bill whose rows don't parse is left out on its own, and the other bills keep their pills. A missing pill is harmless; a wrong one isn't (HM-5). The hosted project's `max_rows` still needs checking (`docs/before-production.md` §6).

**The four requests aren't one snapshot.** Each is its own read, so a host edit landing between them could mislabel a bill until the next refresh. Accepted for now; the upgrade path is one database function that returns all the rows at once (`docs/before-production.md` §6).

**Refreshing without blinking** (SE-UX-14). The bill list shows as soon as `my_bills` lands; it never waits for settle data. On a later refresh (coming back to Home, the app returning to the foreground, pull to refresh), each row **keeps its previous settle pill** until the new settle data arrives, so pills don't flash off and on. Three details:
- Only bills that are still settle candidates keep their old pill. A bill that just became incomplete for its payer loses "Settled up" at once instead of showing it until the read lands (review R4, `keepCandidates` in `app/(app)/index.tsx`).
- A response is used only if it belongs to the latest refresh. An older, slower response is ignored.
- If the new settle read fails, every settle pill is removed, with no error message (the list itself loaded fine). *(Changed 2026-11-27, Home groups v2, A1.S5, user decision: on a **refresh**, a failed read now keeps the previous pills and groups, so nothing moves. The cost is that a pill can be one refresh out of date. Only a failure of the **first** read of a Home visit still leaves no settle pills. Also changed: the first load now waits up to 1000 ms (`FIRST_SETTLE_WAIT_MS`) for settle data before showing the list, so rows appear once, in their final groups. See [design system](design-system.md), section 10.)*

**Code:** `billMarker`, `billMarkerView`, `settleCandidateIds` in `lib/homeMarkers.ts`; `fetchSettleData` in `lib/bills.ts`; `MarkerPill` and the refresh logic in `app/(app)/index.tsx`. Tests: `lib/homeMarkers.test.ts`, `lib/bills.test.ts`, `__tests__/homeMarkers.test.tsx`.

### Sent via Venmo: `sent`, `not_received` and `waiting_on_others` (2026-11-27)
*From spec `docs/specs/2026-11-26-sent-via-venmo.md` (D7, A1) and [ADR 0024](../decisions/0024-sent-via-venmo-and-payment-methods.md).*

Opening Venmo now records "Sent via Venmo" by itself, and Hana (the payer) gets no notification. So Home has to carry the news. Three new pills (`billMarkerView` in `lib/homeMarkers.ts`):

| You are | When | Pill | Colour | Group |
|---|---|---|---|---|
| the payer | someone you haven't seen yet marked a payment to you, **and someone still owes you** | `Sam sent you $15.10` / `Sam paid you $15.10 in cash` / `Sam paid you $15.10` / `2 people sent you money` | grey | Owed to you |
| someone who owes | the payer marked your payment "Not received" and you haven't marked again | `Not received · $15.10` | teal | Waiting on you |
| a guest who has claimed | the bill can't settle yet (`blocked` or `blocked_all_zero`, e.g. an even split still being claimed) | `Claimed · not ready to pay` | grey | Waiting on you |

(The last pill's text is the user's choice, SV-T7-9; the spec first said "Claimed · waiting on others", which clashed with the "Waiting on you" heading.)

Sam's own pills now say how he paid: `Sent $15.10`, `Paid $15.10 in cash`, `Paid $15.10`, and `Sent · $1.10 more to pay`. A guest who has paid in full is hidden from Home (groups v2), so he sees these only when the bill comes back for another reason.

**Groups tell the truth.** The user's rule (SV-ENG-17): "after sam pays it should move out, since she isn't owed for the bill anymore". So `sent` shows **only while someone still owes the payer**. When the last person pays, nobody owes Hana anything, the marker is `settled`, and the bill goes straight to Settled, even if Hana hasn't seen that last send. The news is in the bill's Activity ("Sam sent you $15.10 via Venmo"), not pinned on Home. Two rejected ideas: keeping the bill in Owed to you until Hana looks (it isn't owed), and a "Settled · 1 update" badge. `MARKER_GROUPS` in `lib/homeSections.ts` lists `sent: ['owed']` and `not_received: ['waiting']`, and a test checks every pill lands only in its allowed group.

**"Unseen" is checked per version, with no clock.** `my_bills()` now returns `seen_at`, the last time you opened the bill ([database functions](database-functions.md), "Sent via Venmo"). A send counts as unseen when its mark is **newer** than `seen_at` (strictly later), or when you've never opened the bill at all (`seenAt` null and `seen` false). `sentFacts` in `lib/homeMarkers.ts` does this. There's no "hide after 72 hours" rule (the user dropped it, SV-ENG-9), which also keeps the pill free of the clock, so tests can't go flaky with the time of day.

**When it clears: on every new version, not only when you leave.** The first plan marked the bill seen when the bill or Settle screen lost focus. The engineering review found a race (SV-ENG-7): leaving the screen starts `mark_bill_seen` and, at the same moment, Home comes into focus and refreshes. If Home's read wins, it reads the old `seen_at` and shows "Sam sent you $15.10" again for something Hana just looked at. So now both screens call `markBillSeen` **every time new data arrives while they're in front** (debounced by `SEEN_DEBOUNCE_MS = 2000`, a starting value), plus once on leaving. By the time Hana goes back, the seen time has usually already moved past the send. Code: `useMarkSeen` in `lib/useMarkSeen.ts`, used by `app/(app)/bills/[id]/index.tsx` and `app/(app)/bills/[id]/settle.tsx`. Every route into those screens (Home, a link, an invite resume, a notification tap) goes through the same hook.

**Where `not_received` comes from.** Sam's own flag (`not_received_cents`, `_method`, `_by`) is on his participant row, which Home already reads for settle pills (`fetchSettleData`). So `my_bills()` didn't need it (SV-ENG-8). The pill shows only when Sam is unmarked, owes, and the flag names the **current** payer.

**Still no read receipts.** `seen_at` is returned only to you, from `bill_seen`, which nobody else can read. Hana's seen time never reaches Sam.

### The Activity tab and tab badges (2026-11-28)
*From the tab bar and Activity feed ([ADR 0025](../decisions/0025-tab-bar-and-activity.md), spec `docs/specs/2026-11-28-tab-bar-and-activity.md`). The full story is in [activity feed and badges](activity-feed-and-badges.md).*

*Note on paths:* Home moved from `app/(app)/index.tsx` to `app/(app)/(tabs)/index.tsx`. Wherever this note says `app/(app)/index.tsx` (`MarkerPill`, `keepCandidates`, the refresh logic), read the new path.

Home's pills and the "added you" card are still how a single bill tells you it needs you. On top of that there are now two more in-app signals, still with no push:
- **Badges on the tab bar.** Tabs shows how many bills are waiting on you or owed to you (`tabsBadgeCount` in `lib/tabBadges.ts`, from the same `sections` Home draws). Groups shows a dot when someone else did something in one of your groups since you last opened it. Activity shows how many bills or groups have something new that involves you, capped at "9+".
- **The Activity tab.** One timeline across all your bills and groups: "Maya added you. Claim what you had", "Sam marked $18.20 paid to you", "Ana says they didn't get your $30.00". Each line opens its bill or group.

**Two kinds of "seen", on purpose.** They answer different questions and live in different places:

| | `bill_seen` (server) | Feed seen times (device) |
|---|---|---|
| Drives | Home's "New" marker, the "added you" card, the `sent` pill | The Activity badge, the unread dots and coloured markers, the Groups dot |
| Stored | In the database, readable only through `my_bills()` | On the phone, `splitit.feedSeen.<userId>` (`lib/feedSeen.ts`) |
| Written when | You open a bill or dismiss the card (`markBillSeen`) | You open a bill, a group or the Activity tab (`markFeedSeen`) |
| Follows you to another phone | Yes | No |

Opening a bill writes both. The feed couldn't reuse `bill_seen`: clients can't read its time (only a yes/no comes back), and the user ruled out new seen tables (U11, FEED-28). Both are private to you: neither tells anyone else that you looked.

**Same habits as the pills.** The badges refresh on mount, on each tab change, and when the app comes back to the front. A failed or late read keeps the previous badges and shows no error, just as a failed refresh keeps Home's pills. A read that might be cut short by `max_rows` counts as "at least", so the badge rounds up to "9+", never down.

### Deleting a group: one popup, and a one-time Home line (2026-11-28)
*From [ADR 0027](../decisions/0027-delete-group.md) (DG-1, DG-7, DG-T6-2, review R1).*

**The one popup.** SplitIt's rule is to confirm inline, inside the card you tapped, not with a pop-up. Deleting a group is the one exception, because the user asked for a popup. `components/ConfirmDialog.tsx` is a small card over a dimmed screen. It's an in-app React Native `Modal`, not `Alert.alert`, because `Alert.alert` doesn't work on web. Three details:
- **Focus lands on the title, not the red button** (review R1). On web, react-native-web's focus trap would otherwise pick the first button, `Delete group`, so a stray Enter would delete the group.
- **It can't be closed mid-delete.** Cancel, a tap outside, Android back and Escape all cancel, but not while the call is running.
- **Errors stay inside it.** A lost connection or a clash ("That didn't go through. Please try again.") shows under the buttons, and you can tap again. A refusal that means "look again" (`group_changed`, `receipts_waiting`) closes it and shows the reason under the group's options.

**The Home line.** After your own delete, Home shows `"Tahoe trip" was deleted.` with a Dismiss link, once. The group screen leaves the name in a small in-memory store (`lib/groupDeletedNotice.ts`) just before it goes Home, and `components/GroupDeletedNotice.tsx` takes it when Home comes into focus. It's keyed to your account, so signing out or switching accounts never shows it to someone else. There's no timer: it stays until you Dismiss it or leave Home, so a screen reader has time to read it. Nobody else is told. Other members who have the group open see "This group was deleted" with a Go home button on their next refetch.

## Pitfalls
- **Two markers that disagree.** "Nothing claimed yet" next to a settle screen saying "you owe nothing" would confuse people; the "bill still incomplete" condition prevents it.
- **A notice that comes back after Dismiss** (an early refresh before the write lands), or **one that never comes back** after you're re-added. Dismissed bills are remembered by bill id *and* the time you joined, so a re-add counts as new (review R2).
- **Read state on a shared row** becomes a read receipt for everyone who can read that row.
- **A second copy of a money rule for a list.** It's tempting to count "who owes" in SQL for Home. That's a second split formula that will drift from `computeShares`. Home runs the same plan as the Settle screen instead, and a test checks they agree.
- **Trusting a list that might be cut short.** PostgREST's `max_rows` truncates silently. Ask for a count, cap the range, and treat a short or full page as a failure when a missing row would make the answer wrong.
- **Clearing pills at every refresh.** They blink off and on every time you come back to Home. Keep the previous ones until the new data lands, but only for bills that can still show one.
- **Guessing when data is missing.** No settle data for a bill means no settle pill, never a guessed one.
- **News that keeps a bill in the wrong group.** A "Sam sent you money" pill tempted us to keep a fully paid bill in Owed to you until seen. Groups follow the money; news goes to Activity.
- **Marking seen only when the screen closes.** The next screen's refresh can read the old value first. Mark seen as each new version arrives, and once more on leaving.
- **Mixing up the two kinds of "seen".** Clearing the Activity badge doesn't clear Home's "New", and the other way round, except that opening the bill writes both. Change each in its own place (`lib/useMarkSeen.ts` for `bill_seen`, `lib/feedSeen.ts` for the feed).
- **A dialog that focuses its destructive button first.** One Enter and it's done. Focus the title (or Cancel), never the confirm.
- **A clock in a pill rule.** "Hide after 72 hours" makes the same data give different pills at different times, and tests flaky. Compare stored times with each other instead (`mark.at` vs `seen_at`).

## Check yourself
1. Sam joined a bill with the link and hasn't claimed anything. Which marker does Sam see? What does the host see on the same bill?
2. Why doesn't "Nothing claimed yet" show once every item is claimed, even if Sam claimed nothing?
3. Why is "seen" a separate table instead of a column on `bill_participants`?
4. Hana is the host and the payer. Sam has paid, Dee hasn't, and every item is claimed. What does Hana's Home row say? What does it say on an early bill where Sam paid before Dee claimed?
5. Why doesn't Home count "people left to pay" with a SQL query in `my_bills`?
6. The hosted project's `max_rows` is 500, and a bill's claims come to 600 rows. What does `fetchSettleData` do, and what does Home show?
7. You come back to Home and the settle read takes two seconds. What do the rows show during those two seconds, and what happens if the read fails?
8. Hana is owed by Sam and Dee. Sam sends $15.10 via Venmo. What does Hana's Home row say, and in which group? What changes when Dee pays too, if Hana still hasn't opened the bill?
9. Why does the bill screen call `markBillSeen` each time new data arrives, rather than only when Hana leaves?
10. Sam's mark is at 12:00:00.500 and Hana's `seen_at` is 12:00:00.500. Is Sam a sender for the `sent` pill? And at 12:00:00.501?
11. Hana opens a bill on her phone, then picks up her laptop. Which "seen" follows her (Home's "New" marker or the Activity badge), and why?
12. Why is the delete confirm a React Native `Modal` and not `Alert.alert`? Why does focus go to its title when it opens?

## Learn more
- https://reactnative.dev/docs/appstate
- React Native, `Modal`: https://reactnative.dev/docs/modal
- https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
- PostgREST, `db-max-rows` (the silent row limit): https://docs.postgrest.org/en/stable/references/configuration.html#db-max-rows
- Supabase JS, `range()` and the `count` option of `select()`: https://supabase.com/docs/reference/javascript/range, https://supabase.com/docs/reference/javascript/select
