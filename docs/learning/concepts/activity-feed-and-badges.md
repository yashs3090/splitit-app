# Activity feed and badges

*Added 2026-11-28 with the tab bar and Activity feed ([ADR 0025](../decisions/0025-tab-bar-and-activity.md), spec `docs/specs/2026-11-28-tab-bar-and-activity.md`, decisions FEED-1 onward in `docs/decisions-to-review.md`). Read [audit log](audit-log.md) first: the feed is built from those same event rows.*

## The idea
An **activity feed** is one timeline of things other people did that involve you, newest first, like a notifications list. A **badge** is the small number or dot on a tab that says "something here is new". Four ideas make SplitIt's version work:

1. **Keyset pagination.** You can't load every event at once, so the feed loads a page at a time. "Page 2" isn't "skip the first 30 rows". It's "give me the rows older than the last one I saw". The last row's `(created_at, id)` is the **cursor**, and each page asks for rows past it. Skipping by count (`OFFSET`) breaks when new rows arrive while you scroll: everything shifts by one, and you see a row twice or miss one. A cursor doesn't shift.
2. **One inclusion rule.** One function decides whether an event belongs in your feed, and everything else (the screen, the badges, the live test) calls it. Two copies of "does this count?" would drift apart, and then the badge says 3 while the screen shows 2.
3. **Device-local seen state.** "Seen" can live on the server (it follows you to every device) or on the phone (it doesn't). SplitIt keeps it on the phone.
4. **A display rule versus a security boundary.** A **security boundary** is something the database refuses, whoever asks. A **display rule** is the app choosing not to show something the database would hand over. Both are useful, but only the first one protects data.

## Why it matters here
Maya adds you to her bill. Sam marks $18.20 paid to you. Ana says she didn't get your $30.00. Before the feed, you'd only find these by opening each bill's Activity screen. Now the Activity tab lists them, and its badge says how many bills or groups have something new.

The user set two limits (U11): **no new database tables or columns for "seen"**, and a migration only if it's truly needed. So the feed has to be built from reads that RLS already allows, on the phone, and "seen" has to live on the phone too.

## How we use it

### Built on the phone from RLS reads
`lib/activityFeed.ts` does all the reading. Every read names its columns (never `select('*')`):
- `loadFeedPlaces`: the bills you're on (`bill_participants`, with your `joined_at` on each), their host and group (`bills`), and your groups (`my_groups()`).
- `fetchEventPage`: one page of `bill_events` or `group_events` for those places, in chunks of 100 ids (`FEED_ID_CHUNK`), so the URL stays short.
- Then the facts a page needs: names (`profiles`, never `venmo_username`), claims and shares (`fetchSettleData`), group payments (`group_payments`) and group snapshots.

Nothing here needed a migration. Participants can already read every one of these rows (spec "Why no migration", FEED-27).

### One rule: `classifyFeedEvent`
`classifyFeedEvent(event, ctx)` in `lib/feedRules.ts` is pure and never throws. For each event it returns `null` (not in your feed) or a `FeedItem` with:
- a **category**: `needs_you`, `money`, `dispute`, `share`, `news`, `rollup` or `done`;
- **`counts`**: true only for `needs_you`, `money`, `dispute` and `share`;
- **the amount it may show**, or none.

Rules every event must pass: it's on one of your bills or groups, it happened at or after you joined (FEED-5), and it isn't yours. Examples:

| Event | In your feed? | Line |
|---|---|---|
| Maya adds you to her bill | yes, `needs_you`, counts | "Maya added you. Claim what you had" |
| Sam marks $18.20 paid to you | yes, `money`, counts, amount shown | "Sam marked $18.20 paid to you" |
| Sam marks $18.20 paid to Maya | no | (a payment between two other people) |
| Ana claims the fries on Maya's bill | yes, `rollup`, doesn't count | "Ana claimed 3 items" once rolled up |
| You claim the nachos | no | (your own action) |

The filters (`inFeedFilter`) and the badge count (`activityUnreadCount`) are in the same file and use the item's category, never the raw event.

### Merging two tables with keyset paging
Bill events and group events are in two tables, but the feed is one list. `fetchFeedPage` keeps a cursor and a small buffer for **each** table. It takes whichever buffered row is newer, until the page has 30 lines (`FEED_PAGE_SIZE`), then stops. Rows the rule drops still move the cursor, so they're never fetched again.

**The order rule** is `feedOrder` / `compareFeedRows`: `created_at` newest first, then `id` (as a lowercase string) as the tiebreaker. Both tables use the same rule, so a bill event and a group event with the same time always sort the same way (U9). The tiebreaker matters because one database call can write two events with the same `created_at` (A3.3).

**The cursor filter** asks for rows strictly past the last row seen:
```ts
// lib/activityFeed.ts, fetchEventPage
q.or(`created_at.lt."${cursorIso}",and(created_at.eq."${cursorIso}",id.lt.${cursor.id})`)
```
In words: older than the cursor, or the same time and a smaller id.

**Microsecond precision.** Postgres stores `timestamptz` to the microsecond (`…:00.123456+00:00`). A JavaScript `Date` keeps only milliseconds. Suppose the last row on page 1 is at `.123456`, and the next rows are at `.123400` and `.123100`. If the cursor were sent through a `Date`, it would become `.123`, and "older than `.123`" would skip both of those rows for good. So the feed never turns event times into a `Date`:
- `feedTimeMicros` in `lib/feedRules.ts` reads a timestamp as a whole number of microseconds;
- `feedCursorIso` in `lib/activityFeed.ts` writes the cursor back with all six digits and a `Z`.

The same exact comparison keeps "at or after you joined" right for an event written in the same transaction as your join.

### A full page means "maybe more" (A1.1)
PostgREST, the API in front of the database, stops a response at `max_rows` rows **without an error** (see [in-app notices](in-app-notices.md), "The truncation guard"). So:
- every read asks for an exact count and fails closed if fewer rows arrive than the count;
- a page that comes back **full** (exactly the limit) means "there may be more", never "that's all";
- "That's everything." shows only when both tables returned a short page and both buffers are empty (`end` in `fetchFeedPage`);
- badge reads ask for up to 1000 rows (`FEED_MAX_LIMIT`). If one comes back full, the count is treated as "at least", and `feedBadges` raises it to 10, which shows "9+". It rounds up, never down.

### Roll-ups
Several small actions by others on the same bill, close together, become one line: "Sam, Ana and 2 others claimed 9 items", with "Show 9" to expand it. `rollUp` in `lib/feedRollup.ts` groups consecutive `rollup` items on the same place where each is within 10 minutes of the one before (`ROLLUP_WINDOW_MS`, FEED-12). Any other line in between ends the run, and money, dispute, share, needs-you, news and done lines never join one. When the next page arrives, `rollUpNextPage` re-merges the last run, so a page break never splits it. A run is unseen if any item in it is unseen (`runIsUnseen`).

### One "seen" rule, stored on the device
`lib/feedSeen.ts` stores one JSON value per signed-in user, under `splitit.feedSeen.<userId>`, through `lib/storage` (SecureStore on phones, `localStorage` on web):
```json
{ "activity": "2026-11-28T19:42:00.000Z", "bills": { "<billId>": "…" }, "groups": { "<groupId>": "…" } }
```
Three things write it (`markFeedSeen`):
- **opening a bill**: `app/(app)/bills/[id]/index.tsx`, once the bill has loaded;
- **opening a group**: `app/(app)/groups/[id]/index.tsx`, after the snapshot is ready, once per focus;
- **opening the Activity tab**: `useActivityFeed` in `lib/useActivityFeed.ts`, after the first page loads successfully. It never writes after a failed load, so a failure can't clear anything (FEED-21).

A write never moves a time backwards (it keeps the later of stored and new), and a failed write is ignored.

**The one rule** is `isFeedItemSeen`. An item is seen when the later of your Activity time and its place's time is at or after the item. The place is the bill for bill items, and the group for pure group items. Equal counts as seen; 1 ms earlier doesn't. Anything older than 14 days always counts as seen (`FEED_FIRST_RUN_DAYS`, FEED-29, FEED-34), so a new phone doesn't open at "9+".

Example: Sam marks $18.20 paid to you at 7:42 PM. At 7:50 you open Maya's bill from Tabs. You never open Activity, but that line is now seen, because the bill's time (7:50) is after 7:42.

**Why on the device?** The server has `bill_seen`, but clients can't read its `seen_at`, and `my_bills()` returns only a yes/no (FEED-28). Adding readable seen tables was exactly what the user ruled out (U11). The cost (FEED-30, R3):
- seen state is per device: on a second phone, the last 14 days show as unread once;
- it's lost on reinstall or when browser data is cleared;
- it uses the phone's clock, while event times come from the server's clock. `activitySeenStamp` covers Activity itself by using the newest loaded line's time if that's later than the phone's clock. Bill and group opens still use the phone's clock alone (`docs/before-production.md` §4).

The key is per user, so another person signing in on the same phone never sees your times.

### Badge rules
- **Tabs** (`tabsBadgeCount` in `lib/tabBadges.ts`): bills in Home's claim, pay and owed groups, each counted once (A1.3). Home publishes it from the same `sections` it draws (`publishTabsBadge`), so the badge and the list can't disagree. It only knows the 20 bills `my_bills()` returns (FEED-26, A1.5).
- **Groups** (`groupsDot` in `lib/feedRules.ts`): a dot when someone else did something in one of your visible groups (not a rename or a link change) after you last opened that group on this device, or after you joined it.
- **Activity** (`activityUnreadCount`): the number of **places** (bills or groups) with at least one unseen item that counts. Two new lines on Maya's bill count as 1.
- **Text** (`badgeText`): nothing for 0, "1" to "9", then "9+". A screen reader hears "more than 9" (`badgeSpokenText`).
- **When they refresh** (`useFeedBadges`): on mount, on every tab change, when the app comes back to the front, and 2 seconds after the last of a run of seen writes. A failed, timed-out or late answer keeps the previous badges and shows no error.

### Privacy is a display rule
The feed shows an amount only when it's your own money: "Sam marked $18.20 paid to you". It never says what Sam paid Maya. `classifyFeedEvent` enforces that, and the tests check it across every fixture (criterion 4).

But that is a **display rule**, not a security boundary. RLS lets every participant read every `bill_events` row on their bills, amounts included. The per-bill Activity screen already shows "Sam marked $18.20 paid to Maya" to everyone on the bill, and a script with your login could read the same rows. So the feed's rule makes the timeline about *you*. It doesn't make anyone's payments secret. If that ever has to change, the fix is in the database (a narrower policy or a read function), not in the app (risk R1, `docs/before-production.md` §4). Compare `bill_seen` in [row-level security](row-level-security.md), which really is private: no client can read it at all.

### Markers are coloured only while unread
Each line has a round marker with an icon. Colour comes from `feedMarkerTone` and `FEED_MARKER_TONES` in `lib/feedText.ts`, used only by `components/FeedMarker.tsx`:

| Line | While unread | Once seen |
|---|---|---|
| needs you ("Maya added you") | amber (`warningSurface` / `warning`) | grey |
| money ("Sam marked $18.20 paid to you") | green (`successSurface` / `success`) | grey |
| dispute ("Ana says they didn't get your $30.00") | light orange (`disputeSurface` / `dispute`) | grey |
| everything else | grey (`surfaceMuted` / `textMuted`) | grey |

The icon never changes, so meaning doesn't depend on colour. An unread line also gets a small `primary` dot, hidden from screen readers; its label starts with "Unread." instead. The screen uses the seen times it read **before** marking Activity seen, so the colours and dots show for this visit and are gone on the next. The feed has no row backgrounds, bold text or coloured text (criterion 51).

## Pitfalls
- **Paging with `OFFSET`.** New events arrive while you scroll, and every row shifts. Use a cursor on `(created_at, id)`.
- **A cursor with no tiebreaker.** `created_at < last` alone skips the other rows that share the last row's time. Add `id`, and use the same order rule on both tables.
- **Turning a database time into a `Date`.** It drops the microseconds, and the cursor then skips rows. Keep the text, or compare in microseconds (`feedTimeMicros`).
- **Treating a full page as the end.** A page of exactly the limit might have been cut by `max_rows`. Only a short page means "done".
- **Filtering events in a second place.** A screen that adds its own "skip renames" check will disagree with the badge. Change `classifyFeedEvent` instead.
- **Marking seen before the page loads.** A failed load would clear unread items you never saw. Mark seen only after the first page succeeds.
- **Thinking a display rule protects data.** Hiding an amount on one screen doesn't hide it from the API. Ask "can they read the row?", not "do we show it?".
- **One seen key for everyone on the device.** A second person signing in would inherit the first person's seen times. Key it by user id.
- **Colour as the only signal.** Every marker keeps its icon, and an unread line says "Unread." to screen readers.

## Check yourself
1. Page 1 ends at a row with `created_at` `…:00.123456Z`. Why would sending the cursor as `…:00.123Z` lose rows, and which rows?
2. Bill event B and group event G have the same `created_at`. B's id is `9f…` and G's is `a1…`. Which comes first in the feed, and why does it matter that both tables use the same rule?
3. The badge read for your bills returns exactly 1000 rows. What does the Activity badge show, and why not the count it worked out?
4. Sam marks $18.20 paid to you at 7:42 PM. At 7:50 you open the bill from Tabs. At 8:00 you open Activity. Is the line coloured? What if you'd opened the bill at 7:41?
5. Two new lines on Maya's bill and one in "Tahoe trip": what does the Activity badge say?
6. The feed never shows "Sam marked $18.20 paid to Maya". Can Ana still find that amount? Where, and what would it take to really hide it?
7. You sign in on a new phone. Why don't you see "9+" from a year of history?

## Learn more
- Supabase JS, `or()` filters: https://supabase.com/docs/reference/javascript/or
- Supabase JS, `range()` and the `count` option of `select()`: https://supabase.com/docs/reference/javascript/range, https://supabase.com/docs/reference/javascript/select
- PostgREST, `db-max-rows` (the silent row limit): https://docs.postgrest.org/en/stable/references/configuration.html#db-max-rows
- PostgreSQL, date/time types (`timestamptz` resolution is 1 microsecond): https://www.postgresql.org/docs/current/datatype-datetime.html
- MDN, `Date` (a time value is whole milliseconds): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
- Expo Router, tabs: https://docs.expo.dev/router/advanced/tabs/
- Keyset pagination explained (not official docs, a well-known guide): https://use-the-index-luke.com/no-offset
- In this repo: [audit log](audit-log.md), [in-app notices](in-app-notices.md), [row-level security](row-level-security.md), [design system](design-system.md) section 11, [auth and deep links](auth-and-deep-links.md) "Tabs under the stack"
