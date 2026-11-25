# In-app notices and bill markers

## The idea
A **notification** reaches you even when the app is closed (push). An **in-app notice** only shows while you're using the app. SplitIt has no push yet (that needs a paid Apple account, a push service and a backend decision), so it tells you about new things the cheap, reliable way: the next time Home loads, it shows what changed.

A **marker** is a small word on a list row that says "this one needs you", like an unread dot in a mail app, but always written as a word so it doesn't rely on colour.

## Why it matters here
When a host adds you to a bill, you didn't do anything, so you have no reason to look. Without a notice, you'd find the bill by accident, or never. And a bill can't settle until every item is claimed, so a friend who never notices holds everyone up.

## How we use it
Spec: `docs/specs/2026-11-24-bill-markers-and-notices.md`. Code: `lib/homeMarkers.ts` (the rules and all copy), `components/AddedNotice.tsx` (the card), `app/(app)/index.tsx` (Home).

**Markers, one per row, first match wins** (`billMarker`):
1. Your own bill (you're the host): no marker, ever.
2. **"New"**: the host added you, and you haven't opened the bill or dismissed the notice.
3. **"Nothing claimed yet"**: you're not the payer, you've claimed nothing, and the bill still has unclaimed items. Once every item is claimed it disappears, so it can never contradict the Settle screen's "You owe" or "nothing to pay".
4. Otherwise: no marker.

**The card** (`addedNotice`) lists the same bills as "New": "Hana added you to a bill · Nov 20 · $44.80" with Open and Dismiss, or "You were added to 2 bills" with Dismiss. Dismiss marks those bills seen. It's a card, not a pop-up, so it never interrupts anything.

**When it updates:** Home reloads when it comes into view and when the app returns to the foreground (on web, when you switch back to the tab). It doesn't listen live, so if you're staring at Home when you're added, you see it on your next switch. See [realtime](realtime.md), "Home doesn't use Realtime".

**No read receipts:** "seen" lives in its own private table, `bill_seen`, that only you can affect, through `mark_bill_seen` and `my_bills`. Opening a bill sends no broadcast and writes no Activity, so the host can't tell when you looked. See [row-level security](row-level-security.md), "Read state is owner-only".

## Pitfalls
- **Two markers that disagree.** "Nothing claimed yet" next to a settle screen saying "you owe nothing" would confuse people; the "bill still incomplete" condition prevents it.
- **A notice that comes back after Dismiss** (an early refresh before the write lands), or **one that never comes back** after you're re-added. Dismissed bills are remembered by bill id *and* the time you joined, so a re-add counts as new (review R2).
- **Read state on a shared row** becomes a read receipt for everyone who can read that row.

## Check yourself
1. Sam joined a bill with the link and hasn't claimed anything. Which marker does Sam see? What does the host see on the same bill?
2. Why doesn't "Nothing claimed yet" show once every item is claimed, even if Sam claimed nothing?
3. Why is "seen" a separate table instead of a column on `bill_participants`?

## Learn more
- https://reactnative.dev/docs/appstate
- https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
