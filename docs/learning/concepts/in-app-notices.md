# In-app notices and bill markers

## The idea
A **notification** reaches you even when the app is closed (push). An **in-app notice** only shows while you're using the app. SplitIt has no push yet (that needs a paid Apple account, a push service and a backend decision), so it tells you about new things the cheap, reliable way: the next time Home loads, it shows what changed.

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

| You are | When | Pill | Colour |
|---|---|---|---|
| someone who owes | you can pay (the bill is complete, or it's an early proportional bill and you've claimed an item) and haven't marked "I paid" | `You owe $15.10` | teal (accent) |
| someone who owes | you've marked "I paid", and there's nothing more to settle yet | `Paid $15.10` | grey (muted) |
| someone who owes | the bill is complete and your share went up after you paid | `Paid · $1.10 more to pay` | teal |
| someone who owes | the bill is complete and your share went down after you paid | `Paid · $1.10 back to you` | grey |
| the payer | the bill is complete and someone who owes hasn't marked "I paid" | `1 person left to pay` / `2 people left to pay` | grey |
| the payer | everyone who owes has marked, but there are differences | `1 difference to settle` / `2 differences to settle` | teal |
| the payer | everyone has paid and there are no differences | `Settled up` | grey |

Nobody else gets a settle pill: people who owe nothing, blocked bills, the all-$0 case, and the payer before the bill is complete (even if people are paying early). Before everyone has claimed, "left to pay" would count people who don't know their share yet (HM-4).

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
- If the new settle read fails, every settle pill is removed, with no error message (the list itself loaded fine).

**Code:** `billMarker`, `billMarkerView`, `settleCandidateIds` in `lib/homeMarkers.ts`; `fetchSettleData` in `lib/bills.ts`; `MarkerPill` and the refresh logic in `app/(app)/index.tsx`. Tests: `lib/homeMarkers.test.ts`, `lib/bills.test.ts`, `__tests__/homeMarkers.test.tsx`.

## Pitfalls
- **Two markers that disagree.** "Nothing claimed yet" next to a settle screen saying "you owe nothing" would confuse people; the "bill still incomplete" condition prevents it.
- **A notice that comes back after Dismiss** (an early refresh before the write lands), or **one that never comes back** after you're re-added. Dismissed bills are remembered by bill id *and* the time you joined, so a re-add counts as new (review R2).
- **Read state on a shared row** becomes a read receipt for everyone who can read that row.
- **A second copy of a money rule for a list.** It's tempting to count "who owes" in SQL for Home. That's a second split formula that will drift from `computeShares`. Home runs the same plan as the Settle screen instead, and a test checks they agree.
- **Trusting a list that might be cut short.** PostgREST's `max_rows` truncates silently. Ask for a count, cap the range, and treat a short or full page as a failure when a missing row would make the answer wrong.
- **Clearing pills at every refresh.** They blink off and on every time you come back to Home. Keep the previous ones until the new data lands, but only for bills that can still show one.
- **Guessing when data is missing.** No settle data for a bill means no settle pill, never a guessed one.

## Check yourself
1. Sam joined a bill with the link and hasn't claimed anything. Which marker does Sam see? What does the host see on the same bill?
2. Why doesn't "Nothing claimed yet" show once every item is claimed, even if Sam claimed nothing?
3. Why is "seen" a separate table instead of a column on `bill_participants`?
4. Hana is the host and the payer. Sam has paid, Dee hasn't, and every item is claimed. What does Hana's Home row say? What does it say on an early bill where Sam paid before Dee claimed?
5. Why doesn't Home count "people left to pay" with a SQL query in `my_bills`?
6. The hosted project's `max_rows` is 500, and a bill's claims come to 600 rows. What does `fetchSettleData` do, and what does Home show?
7. You come back to Home and the settle read takes two seconds. What do the rows show during those two seconds, and what happens if the read fails?

## Learn more
- https://reactnative.dev/docs/appstate
- https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
- PostgREST, `db-max-rows` (the silent row limit): https://docs.postgrest.org/en/stable/references/configuration.html#db-max-rows
- Supabase JS, `range()` and the `count` option of `select()`: https://supabase.com/docs/reference/javascript/range, https://supabase.com/docs/reference/javascript/select
