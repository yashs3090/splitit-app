# Spec: Tab bar, badges and the Activity feed (2026-11-28)

Plan: `docs/plans/bill-splitting-app-2026-11-19.md`. Design approved by the user on 2026-11-27/28 and relayed by the coordinator. Points U1–U12 below are decided and not reopened. Product decisions made here under "build without blocking" are logged as **FEED-1 … FEED-32** in `docs/decisions-to-review.md` § "2026-11-28 · Tab bar and Activity".

Lessons read from `docs/lessons/log.md` (process, expo, rls, testing). The ones that shaped this spec:
- event tiebreakers (2026-11-24 CD-T8-2);
- `max_rows` cuts results off silently (2026-11-25);
- entry-route tests, missed three times;
- requirements with no numbered criterion (2026-11-27);
- react-native-web drops `accessibilityState` and hints (2026-11-27);
- 200% zoom (2026-11-27);
- async endings, late answers and one tap (2026-11-27);
- kept state that outlives its facts, six times;
- per-user state on sign-out (2026-11-21);
- one rule in one place (several entries).

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack; hosted project already exists) | Existing reads only (RLS selects and existing functions) | $0, nothing new |
| Apple / Google / Venmo / push | Not needed. Badges are in-app only and there's no push (no backend, ADR 0010) | $0 |

No new external service, secret, `EXPO_PUBLIC_*` value, migration, table or column.

## Goal

People see at a glance what needs them, from badges on a bottom tab bar. They also get one Activity timeline of the things that involve them: being added, being assigned, payments to or from them, disputes, and their share changing. Each line opens its bill or group.

## User-approved design (decided)

- **U1 Tab bar.** Five slots: Tabs · Groups · (+) · Activity · Profile.
  - "Tabs" is today's Home: the bill sections are unchanged and still collapsible.
  - (+) is a raised round centre button. It opens `/scan` and replaces Home's sticky "Add receipt" bar (HOME-ADD-1).
  - Groups is the existing groups list. Profile is the existing profile screen.
  - Home loses its GroupsSection block and its Groups/Profile header icons.
  - Every deep link and route keeps working.
- **U2 Badges.**
  - Tabs: the number of bills not settled, each counted once, capped at "9+".
  - Groups: a dot when any of your groups has something new since you last opened it.
  - Activity: an unread count of things that involve you, one per bill or group, capped at "9+".
  - Others' claims, renames, link rotations and your own actions never count.
- **U3 Seen rule.** An item is seen if, since it happened, you opened its bill, its group or the Activity tab. **Amended by U11.**
- **U4 Feed.**
  - One timeline, newest first, under day headers: Today / Yesterday / weekday for the past week / date.
  - Filter chips: All · Money · Groups.
  - Every line opens its bill or group.
  - No cap: it paginates as you scroll.
  - Empty state: "Nothing new. When someone adds you to a receipt or pays you, it shows up here."
  - Several others' claims, unclaims, splits or joins on the same bill in a short window roll up into one expandable line. Money lines never roll up.
- **U5 Markers.** Each line has a lucide icon, so meaning never depends on colour. **Colours and icons were finalised in U12.**
- **U6 Left out on purpose:**
  - others' item edits that don't change your share;
  - link changes and renames;
  - your own actions;
  - "X opened your bill";
  - comments and reactions, weekly recaps, upsells;
  - push notifications;
  - inline action buttons;
  - share before→after.
- **U7 Rules.**
  - Payment wording is "Sam marked $X paid to you", never "Sam paid you".
  - Only bills and groups you're currently in.
  - Amounts only for your own money. Never what others paid each other.
  - No Venmo usernames in feed text.
  - Deleted accounts read "Someone".
  - Even mode: no share before the bill is fully claimed.
  - Money is integer cents.
- **U8 "You were removed" lines are dropped (deferred).** They would need a stored record (U11). See FEED-11.
- **U9 Ordering ties** sort by `created_at`, then event id, on the client (U11).
- **U10 Groups-list hues (user, 2026-11-28):** "likewise use the same color scheme on groups - if you have a group where you have to claim an item or if the group is settled - give it a small hue - only for these 2 cases". This reverses GCS-7. The final treatment is in U12.
- **U11 No new stored state (user, 2026-11-28).** First: "dont make db changes / if we need to store new values/columns dont do it". Then clarified: "i didnt mean a blanket no on db migration - i just didnt want two last seen fields and stuff like that". Final rule:
  - no `group_seen` or `activity_seen` tables;
  - no removal-notice records;
  - no other per-user tracking state in the database;
  - "seen" is device-local;
  - a migration is allowed only when something is genuinely necessary for correctness or privacy (for example a read function), and the spec must justify it.

  This spec needs **no migration** (see "Why no migration", FEED-27).
- **U12 Final colours (design review, relayed 2026-11-28).** These are in Contract M and apply only while a line is unread. Dispute is a light orange, per the user: "give it a light orange". Red stays reserved for app errors.

## In scope

1. A bottom tab bar: a custom `tabBar` on Expo Router `Tabs`, with the (+) button and three badges.
2. Moving Home, the groups list and Profile into tabs, and removing Home's header icons, GroupsSection and sticky bar.
3. A client-side feed built from existing RLS reads, with one pure rule function (Contract F) for inclusion, privacy and counting.
4. Device-local seen timestamps (Contract S).
5. `lib/` feed wording, roll-ups, day headers, badge text and the share lookup.
6. The Activity screen, with all its states.
7. Recording "group opened" on the group screen (device-local).
8. Groups-list row hues (U10/U12), including a visible pressed state on tinted rows.
9. Two theme tokens, `disputeSurface` and `dispute`.
10. Updating the router tests to a new Home-ready signal; an ADR, a concept note, the decisions log and before-production items.

## Out of scope (cut on purpose)

- Everything in U6. Inline actions and share before→after are "later".
- "You were removed" lines (U8, FEED-11).
- Any migration, table, column or DB function (U11, FEED-27).
- Push or local notifications for feed items.
- Realtime on the Activity screen. It refetches on focus, on foreground and on pull-to-refresh (FEED-16).
- Changing the per-bill or per-group Activity screens, `lib/activityText.ts`, `lib/groupActivityText.ts`, `lib/homeSections.ts`, `lib/homeMarkers.ts`, or any `bill_payments` / who-paid code.
- Bill names. Bills have no name column: `rowTitle` gives "Maya's bill" / "Your bill". The user's "Taco Night" examples are illustrative. Lines show the place as a caption instead (FEED-2).

## Why no migration (FEED-27)

Every read the feed needs already exists for the signed-in user. This was checked against the migrations:

| Read | Why it's enough |
|---|---|
| `bill_participants` | `grant select ... to authenticated` (`20261121074115`, `20261124091041`) |
| `bill_events` | `bill_events_select_participant` |
| `group_events` | `group_events_select_member` |
| `my_groups()` | Returns `joined_at` and `hidden` (`20261126082511`) |
| `profiles.display_name` | Readable for co-participants and co-members |
| `fetchSettleData` and `fetchGroupSnapshot` | Already used by Home and Groups |

Two things a migration would add, and why this spec gives them up instead:
- **An exact "opened this bill" time.** `bill_seen.seen_at` has no client grant, and `my_bills()` returns only a `seen` boolean (and at most 20 bills). So the coordinator's "use the existing bill_seen" can't give a time. Bills therefore also get a device-local opened time (Contract S, FEED-28).
- **Removal records.** Dropped (FEED-11).

Neither is needed for correctness or privacy. Privacy here is a display rule, not a security boundary (Risk R1). Participants can already read every event row, amounts included, through RLS and the per-bill Activity screen.

## File ownership and coordination

- **Session 92 (Home sections).** Owns `lib/homeSections.ts` and the collapsible UI, and has released Home for this work.
  - This spec may only move `app/(app)/index.tsx` into the tabs group and remove its header icons, sticky bar and GroupsSection (Task 5).
  - Tabs-badge logic goes in a new `lib/tabBadges.ts` that imports from `homeSections` and never edits it.
- **Session 96 (who-paid, `lib/activityText.ts`, `lib/homeMarkers.ts`).** Finished, with nothing in flight.
  - New wording goes in `lib/feedText.ts`, which imports `describeEvent` (from `lib/activityText.ts`) and `describeGroupEvent` (from `lib/groupActivityText.ts`) for roll-up child lines.
  - Neither of those files is edited.
  - Both `payers_changed` and the older `payer_changed` are handled.
  - 96 isn't editing `app/_layout.tsx` or `app/(app)/_layout.tsx`.
- **Shared numbers.** Before Task 1, the main session reserves ADR **0025** (the next free number in `docs/learning/decisions/README.md`) with a stub file. Until that stub exists, this spec calls it "the tab-bar-and-activity ADR". No migration timestamps are needed.

## Shared contracts (each defined once; every task points here)

### Contract A: reads

Every read names its columns. None uses a bare `.select()` or `select('*')`.

**My places** (one function, `loadFeedPlaces(myId)` in `lib/activityFeed.ts`):
- Bills: `.from('bill_participants').select('bill_id, joined_at').eq('user_id', myId)`, paged in ranges of 500 rows with `count: 'exact'`. If fewer rows arrive than the count, the read reads as `network` and fails closed (lesson 2026-11-25; never hard-code `max_rows`).
- Bill facts: `.from('bills').select('id, host_id, group_id, created_at').in('id', ids)`, chunked.
- Groups: `listMyGroups()` (the existing `my_groups()` with `joined_at` and `hidden`). Hidden groups are left out (FEED-18).
- The verify-and-reword rule applies here: check each column name against the installed migrations, and reword if one differs.

**Events** (`fetchEventPage(source, ids, kinds, cursor, limit)`):
- Bill events: `.from('bill_events').select('id, bill_id, actor_id, kind, item_name, details, created_at').in('bill_id', chunk).in('kind', FEED_BILL_KINDS)`.
- Group events: `.from('group_events').select('id, group_id, actor_id, kind, details, created_at').in('group_id', chunk).in('kind', FEED_GROUP_KINDS)`.
- Both are ordered by `created_at desc, id desc`, with `.limit(limit)`.
- The keyset cursor is `(created_at, id)`: `.or('created_at.lt.<at>,and(created_at.eq.<at>,id.lt.<id>)')`. Verify the PostgREST filter syntax and the timestamp encoding in the URL (send ISO with `Z`); reword if they differ.
- Starting values: the id chunk size `FEED_ID_CHUNK` is 100 (it keeps URLs short; verify against hosted limits); `limit` is `FEED_PAGE_SIZE` (30).
- `FEED_BILL_KINDS` and `FEED_GROUP_KINDS` are exactly the kinds named in Contract F's table, defined once in `lib/feedRules.ts`.

**Names:** `.from('profiles').select('id, display_name').in('id', actorAndCounterpartIds)`.
- A missing row (deleted account, or no longer shared) reads "Someone".
- A blank name reads "A friend".
- The `venmo_username` column is never selected.

**Facts for a page:**
- `fetchSettleData` for the bills a page needs. It takes at most 20 ids per call, so call it in batches. The data is used for claims, line items, shares and settle state.
- `fetchGroupSnapshot` for groups with a group-settled candidate.
- Group payment rows for `payment_undone`: `.from('group_payments').select('id, from_user, to_user, cents').in('id', paymentIds)`. Verify the table name and its grants in `20261126090704_group_payments.sql`. If it isn't readable, use the matching `payment_recorded` events (`paymentsFromEvents`).

**Merge:**
- The two sources are merged by `(created_at desc, id desc)`, with `id` compared as a lowercase string. The same rule applies to both sources (U9).
- Rows fetched but not yet shown stay buffered, together with each source's own cursor.
- A page is complete when it has `FEED_PAGE_SIZE` visible lines, or when both sources are exhausted.
- It fetches at most 3 rounds per page (starting value), then shows what it has; scrolling continues from there.
- The end is reached when both sources return fewer rows than asked for, and the buffer is empty.

### Contract F: the feed rule (one place: `classifyFeedEvent` in `lib/feedRules.ts`)

`classifyFeedEvent(event, ctx) → FeedItem | null`. It is pure and never throws.

`ctx` holds:
- `myId`;
- my `joinedAt` per bill and per group;
- my current claims per bill (from `BillData`);
- the group payment lookup.

It is the **only** place that decides:
- inclusion;
- category;
- whether an item counts toward the badge;
- which amount may be shown (the privacy rule, U7).

The Activity screen, the badges and the live check all call it. Nothing else filters events.

Rules common to every row (null → excluded):
- the place is one of mine (Contract A; RLS also enforces this);
- `created_at >= joinedAt` (FEED-5);
- the actor is not me (a null actor is allowed and reads "Someone").

| # | Source / kind | Included when | category | amount shown | counterpart |
|---|---|---|---|---|---|
| F-a | bill `participant_added` | `details.user_id` = me | needs_you | none | |
| F-b | bill `assigned` | `details.user_id` = me | needs_you | none | |
| F-c | bill `marked_paid` | `details.payer_id` = me | money | `cents` | actor |
| F-d | bill `paid_difference` | `details.payer_id` = me | money | `to − from` | actor |
| F-e | bill `paid_back` | `details.user_id` = me | money | `from − to` | actor |
| F-f | bill `unmarked_paid` | `details.user_id` = me | money | `cents` | actor |
| F-g | bill `not_received` | `details.user_id` = me | dispute | `cents` | actor |
| F-h | bill `amounts_changed` | I have ≥ 1 claim on the bill now | share | none (fields) | |
| F-i | bill `extras_split_changed` | I have ≥ 1 claim on the bill now | share | none | |
| F-j | bill `item_removed` | me in `details.claimer_ids` | share | none | |
| F-k | bill `item_changed` | `details` has `price_cents` or `qty`, and I now claim a row of that bill whose name = `item_name` (FEED-6) | share | none | |
| F-l | bill `split_changed` | me in the keys of `details.before` or `details.after` | share | none | |
| F-m | bill `unassigned` | `details.user_id` = me | share | none | |
| F-n | bill `payers_changed` | me among the `before`/`after` user ids, or as `from_user`/`to_user` in `moved` | share | none | |
| F-o | bill `payer_changed` (older events) | `details.before` or `details.after` = me | share | none | |
| F-p | bill `claimed`, `unclaimed`, `joined` | always (they are others' actions) | rollup | none | |
| F-q | bill `split_changed`, `assigned`, `unassigned`, `participant_added` | not about me (F-a/F-b/F-l/F-m don't apply) | rollup | none | target user |
| F-r | group `payment_recorded` | `details.to` = me, or `details.from` = me | money | `cents` | the other party |
| F-s | group `payment_undone` | the payment has me as from or to, and it isn't F-t | money | the payment's cents | the other party |
| F-t | group `payment_undone` | actor = payment.to and payment.from = me ("Not received") | dispute | the payment's cents | actor |
| F-u | group `expense_added`, `expense_edited`, `expense_deleted` | always | news | `details.amount_cents` (for edited, the after amount) | |
| F-v | group `bill_added`, `bill_removed` | always | news | none | the bill's host |
| F-w | group `member_joined` | always | rollup | none | |

Derived milestones are built from rows already loaded (FEED-10). They have category `done`, never count, and sort directly above the event they come from:
- **fully claimed:** the newest claimed / unclaimed / assigned / unassigned / item_added / item_removed / item_changed / split_changed event of a bill that is complete now. "Complete" uses the lib completeness rule the bill screen already uses; verify its name. Reword if no single lib rule exists, and don't write a second one.
- **all square:** the newest money event involving me on a bill (F-c … F-g, or my own marked_paid / paid_difference / paid_back / unmarked_paid). Kept only if `homeRowView(...)` puts the bill in `settled`.
- **group settled:** the newest group payment event involving me. Kept only if `groupHomeStatus(...).kind === 'settled'`. The counterpart is the other party of that payment.

Excluded explicitly, each with a test:
- `bill_created`, `item_added`;
- an `item_changed` that only changes the name or note;
- `link_rotated`, `left`, `participant_removed`, `moved_to_group`, `removed_from_group`;
- payments between two other people (bill or group);
- every event of mine;
- group `group_created`, `member_left`, `renamed`, `link_rotated`;
- events before my `joinedAt`;
- hidden groups;
- unknown kinds;
- malformed details (a non-integer or negative amount, a bad uuid).

**Privacy (display rule, U7).**
- An amount reaches a line only in the rows marked "amount shown" above.
- No other field of `details` is passed to wording, apart from user ids and item names.
- Venmo usernames are never read.

**Counts.** `counts` is true exactly for `needs_you`, `money`, `dispute` and `share`.

**Filters:**
- **Money:** `money`, `dispute`, `share`, plus the all-square and group-settled milestones.
- **Groups:** items with a group (group events, plus bill events whose bill has a `group_id`).
- **All:** everything.

**Badge rule.**
- The Activity unread count is the number of distinct places (the `bill_id` if present, else the `group_id`) among counted items that are not seen (Contract S).
- `badgeText(n)`: 0 → no badge; 1–9 → `"n"`; 10 or more → `"9+"`.

### Contract G: Groups dot (in `lib/feedRules.ts`)

`groupsDot(events, ctx)` is true when a visible group has a `group_events` row where:
- the actor ≠ me (a null actor counts);
- the kind is not `renamed` or `link_rotated`;
- `created_at > (that group's device-local opened time, or else my joined_at for it)`.

### Contract S: seen (device-local; `lib/feedSeen.ts`)

- **Storage.** One `lib/storage` key per signed-in user: `splitit.feedSeen.<userId>`. It holds JSON `{ activity: iso | null, bills: { [id]: iso }, groups: { [id]: iso } }`.
  - Only timestamps; nothing else.
  - Writes go through the existing chunked storage. On native, SecureStore values are chunked at 1800 bytes (`lib/storage.native.ts`), so size is handled.
  - Places that are no longer mine are pruned on each write.
- **Writes.**
  - `markFeedSeen('activity')`: when the Activity tab's first page of a focus has loaded.
  - `markFeedSeen('bill', id)`: wherever the bill screen calls `markBillSeen` today.
  - `markFeedSeen('group', id)`: when the group screen's snapshot first loads `ready` on each focus.
  - The value is always `max(stored, now)`, so a clock change never moves it backwards.
  - A failed storage write is ignored: the badge just stays.
- **Rule.** An item is seen when `max(activity, place) >= item.at`. The place is the bill's time for bill items and bill milestones, and the group's time for pure group items. A missing time means "never". Boundary: equal counts as seen; 1 ms earlier is unseen.
- **First run** (no stored `activity`). The unread window starts at `now − FEED_FIRST_RUN_DAYS`, which is 14 days (starting value; FEED-29). The same floor bounds the badge reads.
- **Badge reads.**
  - Events since `max(floor, activity seen)`, using the same Contract A queries plus `.gt('created_at', since)`.
  - Paged with `count: 'exact'`; a cut-off read fails closed and the previous badges stay.
  - Then `classifyFeedEvent` and the rule above are applied.
- **Sign-out.** The key is per user, so another person on the same device never sees these timestamps. Data is kept across sign-out (it's timestamps only) and cleared when the "same device, different user" test passes (FEED-30).

### Contract C: copy (exact strings; `lib/feedText.ts`)

**Placeholders:**
- `{actor}`: the actor's display name, trimmed. "Someone" when missing, "A friend" when blank. `{counterpart}` works the same way.
- `{amount}`: `formatCents(cents)`.
- `{item}`: the item name, trimmed.
- `{share}`: the share from Contract H.
- Interpolated text is cleaned of control characters, as `safeGroupNamer` does.

**Caption:** `"{place} · {time}"`.
- For a bill, `{place}` is `rowTitle`'s wording ("Your bill" / "{host}'s bill" / "A friend's bill"), plus `" · {group name}"` when the bill is in a group.
- For a group, `{place}` is the group name.
- `{time}` is local, like "7:42 PM".

| Id | Item | Sentence | Category · glyph |
|---|---|---|---|
| C1 | F-a | `{actor} added you. Claim what you had` | needs_you · `hand` |
| C2 | F-b | `{actor} assigned you {item}` | needs_you · `list-checks` |
| C3 | F-c, F-r to me | `{actor} marked {amount} paid to you` | money · `banknote` |
| C4 | F-d | `{actor} marked {amount} more paid to you` | money · `banknote` |
| C5 | F-e | `{actor} paid you back {amount}` | money · `banknote` |
| C6 | F-f | `{actor} undid your {amount} payment` | money · `banknote` |
| C7 | F-r from me (recorded by the other person) | `{actor} marked {amount} from you as received` | money · `banknote` |
| C8 | F-s | `{actor} undid the {amount} payment` | money · `banknote` |
| C9 | F-g, F-t | `{actor} says they didn't get your {amount}` | dispute · `circle-alert` |
| C10 | F-h | `{actor} changed {fields}` + share clause | share · `refresh-cw` |
| C11 | F-i | `{actor} changed how tax and tip are split` + share clause | share · `refresh-cw` |
| C12 | F-j | `{actor} removed {item}, which you'd claimed` + share clause | share · `refresh-cw` |
| C13 | F-k | `{actor} changed {item}` + share clause | share · `refresh-cw` |
| C14 | F-l | `{actor} changed the split on {item}` + share clause | share · `refresh-cw` |
| C15 | F-m | `{actor} removed you from {item}` + share clause | share · `refresh-cw` |
| C16 | F-n, F-o | `{actor} changed who paid` | share · `refresh-cw` |
| C18 | F-u added | `{actor} added {item}, {amount}`; with no title: `{actor} added an expense of {amount}` | news · `receipt` |
| C19 | F-u edited | `{actor} edited {item}`; with no title: `{actor} edited an expense` | news · `receipt` |
| C20 | F-u deleted | `{actor} deleted {item}, {amount}`; with no title: `{actor} deleted an expense of {amount}` | news · `receipt` |
| C21 | F-v added | `{counterpart}'s receipt was added`; if it's mine: `Your receipt was added` | news · `receipt` |
| C22 | F-v removed | `{counterpart}'s receipt was taken out`; if it's mine: `Your receipt was taken out` | news · `receipt` |
| C23 | fully claimed | `This bill is fully claimed, so totals are final`, plus `. Your share is {share}` when Contract H gives a share | done · `circle-check` |
| C24 | all square | `You're all square on this bill` | done · `circle-check` |
| C25 | group settled | `You and {counterpart} are settled up`; with no counterpart: `You're settled up` | done · `circle-check` |
| C26 | a roll-up item alone | `describeEvent(...)` or `describeGroupEvent(...)`, given a details object built only from ids (`{}`, plus `{ user_id }` for assigned / unassigned / participant_added) | rollup · `users-round` |
| C27 | a roll-up run | Contract R | rollup · `users-round` |

(C17, the removal line, is dropped: FEED-11.)

- **Expense titles (C18–C20).** The expense's current title comes from the group snapshot when it's loaded. Otherwise the line uses the no-title form.
- **Fields (C10).** `tax_cents` → "the tax", `tip_cents` → "the tip", `fees_cents` → "the fees", any discount key → "the discount" (listed once), `total_cents` → "the total".
  - They are listed in that order: "the tip", "the tip and the tax", "the tip, the tax and the fees".
  - When no known key is present, the text is "the amounts".
- **Share clause.** `. Your share is now {share}` when Contract H gives a share. Otherwise there's no clause, and the sentence has no final period.
- **Money wording.** Never "{actor} paid you". C5's "paid you back" is the user's own example and the only form with those words.
- **Bad data.** A missing or non-integer amount where a line needs one → no line. Never "$NaN", and never a "$0.00" the data didn't say.

**Day headers** (`dayHeader(at, now, fmt)`, local time):
- the same day → `Today`;
- the day before → `Yesterday`;
- 2–6 days earlier → the weekday (`Monday`);
- older and in the current year → `Nov 18`;
- older and in another year → `Nov 18, 2025`.

**Screen copy:**
- Title: `Activity`. Chips: `All`, `Money`, `Groups`.
- Loading: a spinner labelled `Loading activity`.
- First-load error: `Couldn't load your activity.` + `Try again`.
- Empty:
  - All: `Nothing new. When someone adds you to a receipt or pays you, it shows up here.`
  - Money: `No money activity yet.`
  - Groups: `No group activity yet.` (FEED-24)
- Loading more: a spinner labelled `Loading more activity`.
- Load-more error: `Couldn't load more.` + `Try again`.
- End of the list: `That's everything.`
- A refresh that fails while a list is on screen: the list stays and no error shows.
- Roll-up toggle: `Show {n}` / `Hide`, with the labels `Show the {n} changes` / `Hide the changes`.
- A line's accessibility label: `Unread. ` (only when unseen) + sentence + `. ` + place + `. ` + time.

**Tab bar:**
- Labels: `Tabs`, `Groups`, `Activity`, `Profile`. The (+) button is labelled `Add receipt`.
- Accessibility labels go in the label itself, because react-native-web drops hints:
  - `Tabs, {n} open bills` / `Tabs`;
  - `Groups, new activity` / `Groups`;
  - `Activity, {n} new` / `Activity` ("9+" is read as "more than 9");
  - `Profile`;
  - `Add receipt, opens a photo or typing the items`.
- Icons: Tabs `receipt`, Groups `users-round`, (+) `plus`, Activity `bell`, Profile `circle-user-round`.
- Every glyph in this spec exists in the installed `lucide-react-native` 1.80.0. Checked: `node_modules/lucide-react-native/dist/cjs/icons/{hand,list-checks,circle-alert,banknote,circle-check,refresh-cw,receipt,users-round,plus,bell,circle-user-round,check}.js`.

### Contract M: markers and the unread dot (final, U12)

- **Circle.** 32 pt, with a 16 pt icon at `ICON_STROKE` (`lib/theme.ts`). Top-aligned to the first line of text, with a `space.md` gap.
- **Colour only while unread.** Once seen, every marker becomes neutral and keeps its glyph.

| Tone (unread) | Fill | Icon |
|---|---|---|
| needs_you | `warningSurface` (existing faint tint; the user declined stronger ones) | `warning` |
| money (involving you) | `successSurface` | `success` |
| dispute | new `disputeSurface` | new `dispute` |
| neutral: done, share, news, rollup, and every read line | `surfaceMuted` | `textMuted` |

- **New tokens in `lib/theme.ts`:**
  - light: `disputeSurface #FFF6ED`, `dispute #C4320A`;
  - dark: `disputeSurface #3A1D0B`, `dispute #FDBA8C`.
  - The PM's own calculation gives about 5.2:1 (light) and 9.3:1 (dark), icon against fill. A unit test must confirm both are at least 3:1 for the icon, and at least 4.5:1 if any text is ever drawn in `dispute`.
  - Red (`danger`) is not used in the feed. It stays for app errors.
- **Unread dot.** 8 pt, `primary`, trailing, centred on the first line. Hidden from screen readers; the label starts `Unread.`
- **The feed has no row backgrounds, no bold text and no coloured text.**
- **One map, `FEED_MARKER_TONES`, in `lib/feedText.ts`.** It's consumed only by `components/FeedMarker.tsx`.

**Groups-list rows (U10):**
- A `claim` row gets the `warningSurface` fill through `ListRow` `highlight`.
- A `settled` row gets the `surfaceMuted` fill, plus a `check` glyph next to the "Settled up" caption.
  - The title stays in `text` and is never dimmed. The chevron stays at full `textMuted`.
  - Because `surfaceMuted` is exactly `ListRow`'s pressed colour, a highlighted row gets a pressed state that differs from its fill: content opacity 0.7 (starting value), with the fill kept.
  - FEED-20 records the design review's alternative: a plain row with a check caption.
- Every other state (owe, owed, waiting, loading) stays plain.

### Contract H: the share shown in a line

- `feedShareCents(data: BillData, myId): number | null`, in a new `lib/feedShare.ts`.
- It uses the bill screen's split path (`splitInputFor` → `computeShares`), never a component.
- It's the **current** share.
- It returns null when:
  - the bill is in even mode and not every item is claimed;
  - I have no share;
  - the data didn't load.

### Contract R: roll-ups (`lib/feedRollup.ts`)

- `ROLLUP_WINDOW_MS` is 10 min (starting value).
- **What forms a run.** Walking the feed in order, consecutive `rollup` items form one run when they:
  - are on the same place;
  - each fall within the window of the previous item.
- **What ends a run.** Any other item in between. Money, dispute, share, needs_you, news and done items never join a run.
- **Paging.** When a page arrives, the last run of the previous page is merged with the new rows again, so paging never splits a run.
- **Sentence:**
  - n = 1 → C26.
  - All `claimed` → `claimed {n} items`.
  - All joins (`joined` / `member_joined` / `participant_added`) → `{names} joined`. For `participant_added` the people named are the added users.
  - Anything else → `made {n} changes`.
- **Names** (distinct, newest first): `{A}` / `{A} and {B}` / `{A}, {B} and 1 other` / `{A}, {B} and {k−2} others`.
- **Expanded:** the C26 sentence of each item, newest first.
- **Seen:** a run is unseen if any item in it is unseen.

### Contract T: time limits

- Every call here, feed reads and badge reads alike, gives up after 15 s and reads as `network`. Reuse `GROUP_REQUEST_TIMEOUT_MS`'s value.
- Only the newest request of each kind applies its answer. Late answers are ignored.
- Storage reads and writes get the same limit.

## Tasks

- Agents run `npm test -- --maxWorkers=4` or single files, and only one full suite runs at a time across sessions.
- Handoffs quote this spec's names and never restate them from memory. Where a handoff and this spec differ, the spec wins.

**Task 0 (main session).**
- Reserve ADR 0025 with a stub file.
- Announce the file lists below to sessions 92 and 96.

**Task 1 (implementer): feed rules.**
- New `lib/feedRules.ts` (+ test): `classifyFeedEvent`, `groupsDot`, `badgeText`, `FEED_BILL_KINDS`, `FEED_GROUP_KINDS`, the filter rule and the badge rule (Contracts F and G).
- New `test-utils/feedFixtures.ts`: one event per F-row and per boundary case, shaped like the Contract A selects.

**Task 2 (implementer): data layer and seen state.**
- New `lib/activityFeed.ts` (+ test): `loadFeedPlaces`, `fetchEventPage`, the merge and buffer, `fetchFeedPage(filter, state)`, `fetchBadgeInputs` (Contract A and T).
- New `lib/feedSeen.ts` (+ test), Contract S.

**Task 3 (implementer): wording and the theme tokens.**
- New `lib/feedText.ts` (+ test): Contract C, day headers and `FEED_MARKER_TONES`.
- `lib/theme.ts`: add `disputeSurface` and `dispute` to the type and to both palettes, with the contrast test in `lib/theme.test.ts` (new, or the existing file if there is one).

**Task 4 (implementer): roll-ups, share, view model.**
- New `lib/feedRollup.ts` (+ test).
- New `lib/feedShare.ts` (+ test).
- New `lib/feedView.ts` (+ test): `feedView(items, facts, seen, now, fmt)` returns day sections, and each line has its sentence, caption, tone, glyph, unread flag, accessibility label and `opens` (`{ bill } | { group }`).
  - Milestone candidates are kept or dropped here.
  - Facts loading (`fetchSettleData` batches, snapshots, payment rows) lives in `lib/activityFeed.ts`.

**Task 5 (product-engineer): tab bar and route moves.**
- **Stack layout.** `app/(app)/_layout.tsx` keeps the auth guard and `SentCheckResponder`, and puts the tabs group under every pushed screen. Use `unstable_settings.initialRouteName` or the equivalent, so a cold deep link has Tabs below it; verify against expo-router ~57.0.31.
- **Tabs layout.** New `app/(app)/(tabs)/_layout.tsx`: `Tabs` with `tabBar={(p) => <TabBar {...p} />}`. The props `tabBar`, `tabBarBadge` and `tabBarButton` exist in expo-router 57's vendored `react-navigation/bottom-tabs/types.d.ts`.
- New `components/TabBar.tsx`.
- **Moves:**
  - `app/(app)/index.tsx` → `app/(app)/(tabs)/index.tsx`;
  - `app/(app)/groups/index.tsx` → `app/(app)/(tabs)/groups.tsx`. `groups/new.tsx` and `groups/[id]/*` stay where they are; verify that `/groups` and `/groups/<id>` both still resolve.
  - `app/(app)/profile.tsx` → `app/(app)/(tabs)/profile.tsx`, with no back control;
  - new `app/(app)/(tabs)/activity.tsx`, with a placeholder until Task 8.
- **Home:**
  - Remove the Groups/Profile `IconButton`s, the sticky bar (the `splitHeading` / `addReceipt` usage) and both `<GroupsSection>` elements.
  - Keep the `SplitIt` heading (role header). It is the **Home-ready signal**.
- **(+)** is not a route. It sits between Groups and Activity and calls `router.push('/scan')`, with a synchronous ref guard against double taps.
- **Profile links.** Settle's `router.push('/profile')` and `VenmoPrompt`'s link must return to where the person was (criterion 41). If a tab can't do that, add `app/(app)/account.tsx`, which renders the same Profile component with a back header, and point both links at it.
- If this task grows past about 300 lines, split the Profile link out as 5b.

**Task 6 (product-engineer): router-test updates** (these land together with Task 5).
- **New wait.** Replace `findByRole('header', { name: 'Split a bill' })` with `findByRole('header', { name: 'SplitIt' })`.
  - First confirm that no other screen renders a `SplitIt` header. Not run here: the word sits alone on its JSX line, so the PM's pattern couldn't match it.
- **Files to update.** Each was found by Grep over `__tests__/` today, for `'Split a bill'` and for `'Add receipt'|ADD_RECEIPT|name: 'Groups'|name: 'Profile'|GroupsSection`.

  | File | What changes |
  |---|---|
  | `__tests__/homeMarkers.test.tsx` | `openHome` |
  | `__tests__/homeLayout.test.tsx` | `barOf`; ADD_RECEIPT tests 31/33 rewritten for (+) |
  | `__tests__/billForm.test.tsx` | test 27 presses the tab bar's `Add receipt` |
  | `__tests__/inviteFlow.test.tsx` | the Home-ready wait |
  | `__tests__/venmoPrompt.test.tsx` | the Home-ready wait |
  | `__tests__/shareAndJoin.test.tsx` | Home's Groups/Profile icons or GroupsSection |
  | `__tests__/groupsList.test.tsx` | Home's Groups/Profile icons or GroupsSection |
  | `__tests__/groupsHome.test.tsx` | Home's Groups/Profile icons or GroupsSection |
  | `__tests__/newBillBack.test.tsx` | Home's Groups/Profile icons or GroupsSection |
  | `__tests__/profile.test.tsx` | Home's Groups/Profile icons or GroupsSection |

- **Report.** List every changed assertion as old → new, with the reason. No money or copy assertion is weakened.
- New tab tests go in a new `__tests__/tabBar.test.tsx`.
- Before editing, announce the file list to session 92.

**Task 7 (product-engineer): badges.**
- New `lib/tabBadges.ts` (+ test):
  - `tabsBadgeCount(sections)`: distinct bill ids in every `homeSections(...)` section except `settled`, leaving out hidden ones. Verify the field names.
  - A store that Home writes from the same `sections` value it renders.
  - `useFeedBadges()`, which reads with `fetchBadgeInputs` + `feedSeen` + `classifyFeedEvent`:
    - on mount, on every tab change, and on app foreground;
    - after each `markFeedSeen`.
    - A failed, timed-out or late answer keeps the previous badges.
- `components/TabBar.tsx` renders the badges.
- In `app/(app)/(tabs)/index.tsx`, the only change is publishing the count.

**Task 8 (product-engineer): Activity screen.**
- **Files:**
  - `app/(app)/(tabs)/activity.tsx`;
  - new `components/FeedLine.tsx`;
  - new `components/FeedMarker.tsx` (the only consumer of `FEED_MARKER_TONES`);
  - new `__tests__/activityScreen.test.tsx`.
- **States.** Every Contract C screen state.
- **Pagination.** Pages are requested from `onEndReached`, with a ref guard so only one request is in flight at a time.
- **Chips.** A single-select group with web ARIA. Use `SegmentedControl` if it already provides this, and arrow keys on web. Changing the chip discards the pages, buffer and cursors.
- **Seen.** Call `markFeedSeen('activity')` after a focus's first page loads successfully. The unread dots and tints use the seen state read before that write, so they show for this visit only.
- **Tap.** A tap pushes `/bills/<id>` or `/groups/<id>`, once.
- **Reviews.** A `ui-ux-designer` pass before review. Check at 200% zoom and at the largest Dynamic Type size.

**Task 9 (product-engineer): bill and group opened times.**
- `app/(app)/bills/[id]/index.tsx`: add `markFeedSeen('bill', id)` next to the existing `markBillSeen` call. One line plus the import; this is a shared file, so use exact-string edits.
- `app/(app)/groups/[id]/index.tsx`: add `markFeedSeen('group', id)` once per focus after the snapshot is `ready`.
- Tests: a new `__tests__/feedSeenRoutes.test.tsx`.

**Task 10 (product-engineer): Groups-row hues.**
- `components/ui/ListRow.tsx`:
  - `highlight` accepts `boolean | 'warning' | 'muted'`. `true` stays `'warning'`, so existing callers are unchanged.
  - A highlighted row's pressed state is content opacity 0.7 over its fill.
- `components/GroupsSection.tsx`: the Contract M Groups-list rows, including the `check` glyph next to "Settled up".
- Tests: a new `__tests__/groupsRowHue.test.tsx`.

**Task 11 (qa-tester or implementer, `live-db-smoke` skill): live reconciliation.**
- Bundle `lib/activityFeed.ts`, `lib/feedRules.ts`, `lib/feedText.ts`, `lib/feedView.ts` and `lib/feedRollup.ts` with esbuild.
- Run them against the local stack as throwaway users: Maya (host), Sam, Ana and Me.
- Use the cleanup that works for group members.
- Report N/N.

**Task 12 (docs-writer): docs.** Runs after Tasks 1–11, and reports every bullet as done or skipped.
- Fill ADR 0025, "Tab bar and Activity feed". It covers:
  - the client-side feed with one rule function;
  - device-local seen;
  - no migration (U11), and what was given up;
  - U10/U12.
- New concept note `docs/learning/concepts/activity-feed-and-badges.md`. It covers:
  - keyset pagination over two tables;
  - one inclusion rule;
  - device-local seen versus server state;
  - display rule versus security boundary.
- Update these concept notes:
  - `docs/learning/concepts/in-app-notices.md`;
  - `docs/learning/concepts/row-level-security.md` (privacy here is display-only);
  - `docs/learning/concepts/auth-and-deep-links.md` (tabs under the stack);
  - `docs/learning/concepts/design-system.md` (dispute tokens, tinted-row pressed state).
- Add the ADR row to the README and the index line.
- In `docs/decisions-to-review.md`:
  - HOME-ADD-1 → "Changed: superseded by the (+) tab button (FEED-19)";
  - HOME-ADD-2 stays Open;
  - GCS-7 → "Changed: user, 2026-11-28 (U10, FEED-20)".

**Order.**
- Tasks 1 → 2 → 3 → 4 can run partly in parallel, because the fixtures come from Contract A.
- Tasks 5 + 6 land together.
- Task 7 after 2 and 5.
- Task 8 after 3, 4 and 7.
- Task 9 after 2.
- Task 10 any time after 3.
- Task 11 after 1–9.
- Task 12 last.

## Acceptance criteria

### Feed rules (Task 1; `lib/feedRules.test.ts`, fixtures from `test-utils/feedFixtures.ts`)

1. **Inclusion and category.** Each F-row F-a … F-w has a test. A fixture that meets the row's condition returns that category, `counts` and amount. The same event with the condition unmet (for example, a payment to Maya instead of me) returns null or the roll-up category, as the table says.
2. **Exclusions.** Every explicitly excluded kind or case in Contract F returns null:
   - my own events of every kind;
   - events at `joinedAt − 1 ms` (excluded), and at exactly `joinedAt` (included);
   - hidden groups;
   - unknown kinds;
   - malformed details: `cents` of 18.5, −1 or `"1820"`, and a non-uuid `payer_id`.
3. **Amounts.**
   - `paid_difference` from 1000 to 1285 → 285.
   - `paid_back` from 1285 to 1000 → 285.
   - `payment_undone` uses the looked-up payment's cents, and is dropped when the payment can't be found.
   - No `rollup`, `share`, `news` (except F-u) or `done` item carries an amount.
4. **Privacy (display rule).** Across every fixture:
   - no item exposes an amount for a payment between two people who aren't me;
   - no item carries any `details` field other than ids, item names and the allowed amount.
5. **Badge rule.**
   - Two unseen counted items on bill B1 → 1.
   - Plus one on group G1 → 2.
   - A seen item, an unseen roll-up, news or done item, or my own action adds nothing.
   - `badgeText`: 0 → none, 1 → "1", 9 → "9", 10 → "9+", 12 → "9+". "9+" reads "more than 9".
6. **Groups dot (Contract G).**
   - True for Ana's `expense_added` after G1's opened time.
   - False at exactly the opened time.
   - False for `renamed` or `link_rotated`, for my own events, and for hidden groups.
   - With no opened time, the group's `joined_at` is the bound.
7. **Filters.** Money keeps exactly money, dispute, share and the two money milestones. Groups keeps exactly the items with a group, including a group bill's events.

### Data layer and seen state (Task 2)

8. **Exact reads.** Every Supabase call matches Contract A exactly:
   - the same table and column list;
   - `.in('kind', FEED_BILL_KINDS)` / `FEED_GROUP_KINDS`;
   - ordered by `created_at desc, id desc`.

   A fake client asserts each call's shape. None uses `select('*')` or a bare `.select()`.
9. **Cut-off reads.** The places read pages with `count: 'exact'`. When the fake returns fewer rows than the count, the result is `network` and no partial list is used. When it returns 1,200 places over three ranges, all 1,200 are used.
10. **Id chunks.** More than `FEED_ID_CHUNK` ids are split into chunks, and every id is queried exactly once.
11. **Merge and paging.**
    - Bill and group events with the same `created_at` merge in `id desc` order.
    - Paging with `FEED_PAGE_SIZE = 2` (overridden in the test) over 7 events, which include 3 with an equal `created_at`, returns each event exactly once and in order. Pages joined = the unpaged order.
    - The end is reported once both sources are exhausted.
    - Rows that are fetched but dropped by the rules still advance the cursor.
    - A page that needs more than 3 rounds returns what it has, and is not marked as the end.
12. **Time limits.** Each call gives up at 15 s (fake timers) and reads as `network`, and its late answer is ignored. Errors: `42501` → `not_allowed`, anything else → `network`.
13. **Seen state.**
    - `markFeedSeen` writes only timestamps, under `splitit.feedSeen.<userId>`.
    - It never moves a value backwards: storing an older `now` after a newer one keeps the newer.
    - It prunes places that are no longer mine.
    - A storage failure is swallowed (the badge stays and nothing is thrown).
    - A second user on the same device (another key) sees none of the first user's times.
14. **Seen boundaries.**
    - An activity time equal to `at` → seen; 1 ms earlier → unseen.
    - A bill time alone clears that bill's items and its milestones, but not group items.
    - A group time alone clears that group's items.
    - First run (nothing stored): items older than 14 days count as seen.

### Wording (Task 3)

15. **Exact sentences.** Each of C1–C16 and C18–C27 has a test with the exact sentence for its fixture, including:
    - "Someone" for a missing name;
    - "A friend" for a blank name;
    - the "it's mine" forms of C21 and C22;
    - the no-title forms of C18–C20;
    - every `fields` combination listed in Contract C.
16. **Money wording.**
    - Every money and dispute sentence matches `/^(.+ marked .+ paid to you|.+ marked .+ more paid to you|.+ paid you back .+|.+ undid (your|the) .+ payment|.+ marked .+ from you as received|.+ says they didn't get your .+)$/`.
    - No sentence from any fixture matches `/ paid you(?! back)/`.
17. **Bad amounts.** A missing or non-integer amount on C3–C9, C18 or C20 gives no line.
18. **Day headers.** With a fixed `now` and injected formatters:
    - `Today` and `Yesterday`;
    - the weekday for 2 and for 6 days earlier;
    - `Nov 18` for 7 days earlier;
    - `Nov 18, 2025` for an earlier year;
    - correct on both sides of local midnight (23:59 / 00:00).
19. **Dispute contrast.** `disputeSurface` / `dispute` exist in the light and dark palettes, and a test computes WCAG contrast: icon against fill is at least 3:1 in both. The `ThemeColors` type includes them, and `npm run typecheck` passes.
20. **Marker tones.** `FEED_MARKER_TONES` maps needs_you, money, dispute and neutral exactly as in Contract M. A read (seen) line of any category resolves to neutral, and keeps its glyph.

### Roll-ups, share, view model (Task 4)

21. **Roll-ups (Contract R).**
    - 3 claims by Sam within 10 min → `Sam claimed 3 items`.
    - 9 claims by four people → `Sam, Ana and 2 others claimed 9 items` (newest first).
    - A claim and a split → `made 2 changes`.
    - Two joins → `Sam and Ana joined`.
    - A money item between two claims splits the run.
    - A gap of exactly 10 min stays in the run; 10 min + 1 ms splits it.
    - Different places never merge.
    - Non-rollup categories never join a run.
    - A run that crosses a page boundary merges when the next page arrives.
    - The expanded children are the C26 sentences, newest first.
    - A run is unseen if any of its items is unseen.
22. **Share (Contract H).**
    - A proportional bill where I have claims → `. Your share is now $X`, where X equals the bill screen's share for the same `BillData`.
    - An even-mode bill with an unclaimed item → no clause on C10–C15, and C23 has no share part.
    - A failed facts read → no clause.
23. **Milestones.** Built through the same functions Home and the Groups list use, not hand-built:
    - all-square is kept only when `homeRowView` puts the bill in `settled`;
    - group-settled is kept only when `groupHomeStatus` is `settled`, and it names the other party;
    - fully claimed appears above its trigger event, and disappears when the bill is no longer complete.
24. **Line fields.** Each line has `opens` (bill or group) and an accessibility label of the form `Unread. ` (only when unseen) + sentence + `. ` + place + `. ` + time.
25. **No money arithmetic in components.** No component in `components/` or `app/` does arithmetic on cents for the feed. The reviewer checks `FeedLine.tsx`, `FeedMarker.tsx`, `activity.tsx` and `TabBar.tsx`.
26. **No Venmo text.** `grep -rn "venmo" lib/feedRules.ts lib/feedText.ts lib/feedView.ts lib/feedRollup.ts lib/feedShare.ts lib/activityFeed.ts lib/feedSeen.ts components/FeedLine.tsx components/FeedMarker.tsx` prints nothing.
    - Not run: these files don't exist yet.
    - The implementer first shows the pattern matches `lib/paylinks.ts`.

### Tab bar and routes (Tasks 5–7)

27. **Home on the Tabs tab.** When signed in, the app opens on the Tabs tab with:
    - the `SplitIt` header;
    - the bill sections unchanged, including `HOME_SECTIONS_START_CLOSED`;
    - no Groups/Profile icons, no "Split a bill" bar and no Groups block.

    Tested on native and on web in `__tests__/tabBar.test.tsx`.
28. **Tab order and selection.** The tabs appear in order: Tabs, Groups, (+), Activity, Profile, each with its icon and label.
    - On native, the selected tab is exposed through `accessibilityState.selected`.
    - On web, it's exposed through `aria-selected` / `aria-current` in the DOM. QA checks this in the browser.
29. **(+).** Pushes `/scan` exactly once, even on a double tap in the same tick. The scan screen offers photo and "Enter items" as it does today. Back returns to the tab you came from.
30. **Tab content.**
    - Groups shows the list exactly as `/groups` did.
    - Profile has no back control.
    - Activity shows the Activity screen.
31. **URLs on web.**
    - `/` → Tabs; `/groups` → Groups; `/activity` → Activity; `/profile` → Profile.
    - `/groups/<id>`, `/groups/new`, `/bills/<id>`, `/bills/<id>/settle`, `/scan`, `/b/<code>` and `/g/<code>` open above the tabs, with no tab bar.
32. **Resume paths.** Each is tested on web and on native:
    - (a) Sign-in with no invite → Tabs.
    - (b) Sign-in with a pending bill invite → the bill. Back → Tabs.
    - (c) Native `/auth/callback` → Tabs. Only the resume effect navigates.
    - (d) A notification tap through `SentCheckResponder` / `lib/resumeGate` opens its target once. Back → the tab that was active (Tabs on a cold start).
    - (e) A cold start on `/bills/<id>` or `/groups/<id>` → Back → Tabs.
    - (f) `/g/<code>` → the group. Back → Tabs.
33. **Back returns to the tab.**
    - From a bill or group opened from Activity, Back returns to Activity with its filter and scroll kept.
    - From one opened from Groups, Back returns to Groups.
34. **"Go home".** Every existing "Go home" button (`router.replace('/')`) lands on Tabs.
35. **Tabs badge.** It equals `tabsBadgeCount` of the very `sections` Home renders. Bills in claim, pay, owed, settled and hidden states, built through `homeRowView` / `homeSections`, give:
    - a badge equal to the number of distinct bills that are neither settled nor hidden;
    - "9" for 9 such bills and "9+" for 10.
36. **Activity and Groups badges.**
    - They show `badgeText(n)` and the dot.
    - They refresh on mount, on each tab change, on foreground (AppState `active`), and after `markFeedSeen`.
    - A failed or timed-out read keeps the previous badges and shows no error. A late answer is ignored.
37. **Bills opened from any route.** A bill opened from a Tabs row, from an Activity line, from `/b/<code>`, or from a cold `/bills/<id>`:
    - records the bill's opened time;
    - drops that bill's items from the Activity badge on the next refresh.

    Tested per route.
38. **Router tests.**
    - Tests that waited on `Split a bill` now wait on the Home-ready signal.
    - Task 6 lists each changed assertion as old → new.
    - `npm test -- --maxWorkers=4` and `npm run typecheck` pass. Failures only in files outside this spec are reported, not fixed.

### Activity screen (Task 8)

39. **Loading.** A spinner labelled `Loading activity`.
40. **First-load error.** A network failure, a timeout or `not_allowed` shows `Couldn't load your activity.` + `Try again`, which refetches. Offline is the same state, with the fake rejecting as a network failure.
41. **Profile links.** From Settle's Venmo link and from `VenmoPrompt`'s link, Profile shows, and one Back (button or gesture) returns to the same Settle screen or to Tabs. (This criterion is for Task 5; it's numbered here.)
42. **Empty states.** The exact empty copy for each of All, Money and Groups.
43. **Day headers.** The lines sit under their day headers (header role), newest first. Each line shows its marker, sentence, caption and, when unseen, the unread dot.
44. **Pagination.**
    - Reaching the end requests the next page once, even while a request is in flight.
    - While it loads: `Loading more activity`.
    - On failure: `Couldn't load more.` + `Try again`, and every loaded line stays.
    - On the last page: `That's everything.`, and nothing more is requested.
45. **Refresh.**
    - A refresh (focus, foreground or pull) that fails keeps the list and shows no error.
    - One that succeeds replaces the pages from page 1.
46. **Chips.**
    - Changing the chip discards the pages and fetches again.
    - A late answer for the old chip is ignored.
47. **Marking Activity seen.**
    - `markFeedSeen('activity')` runs once per focus, only after a successful first page, never after a failed one.
    - Unread lines (tinted marker and dot) show during this visit and are neutral on the next.
48. **Tapping a line.** It pushes its bill or group exactly once, even on a double tap in the same tick.
49. **Roll-up toggle.** `Show {n}` expands the run and `Hide` collapses it. Focus stays on the toggle.
50. **Screen readers and keyboard.**
    - Labels follow Contract C.
    - Markers and dots are hidden from screen readers.
    - On web the chips are one tab stop, the arrow keys move the selection, and `aria-checked` / `aria-selected` is set in the DOM (QA checks in the browser).
51. **No styling beyond markers.** The feed has no row backgrounds, bold text or coloured text (a style assertion on `FeedLine`).
52. **Zoom and text size.** At 200% browser zoom (or 320 px wide), lines wrap, the chips wrap or scroll inside their own row, and nothing clips or scrolls sideways. QA checks this in the browser; the native text size is User check 59.

### Groups (Tasks 9–10)

53. **Recording "group opened".** The group screen, reached from the Groups tab, from an Activity line, from a `/g/<code>` join, from a bill's group link, or from a cold `/groups/<id>`:
    - calls `markFeedSeen('group', id)` exactly once per focus after `ready`;
    - never calls it after a failed load;
    - refreshes the Groups dot afterwards.

    Tested per route.
54. **Row hues.**
    - A `claim` row has the `warningSurface` fill.
    - A `settled` row has the `surfaceMuted` fill and a `check` glyph next to "Settled up", with the title in `text` (not dimmed) and the chevron in `textMuted`.
    - `owe`, `owed`, `waiting` and loading rows have no fill.
55. **Pressed state.**
    - A pressed highlighted row shows content opacity 0.7 and keeps its fill. It never reads as just `surfaceMuted`.
    - An unhighlighted row's pressed state is unchanged.
    - An existing `highlight={true}` caller renders exactly as before.

### Live reconciliation (Task 11)

56. **Live run.** Run as real users on the local stack, cover every F-row, the exclusions, the merge across tied timestamps, paging, the filters and the badge counts. Each case compares:
    - what the bundled lib shows;
    - what the spec's table expects.

    Report N/N. The run also confirms that Maya sees no change in any of her reads when I open a bill, a group or Activity: seen state is device-local, so this is expected to hold.

### Docs and logs (Task 12)

57. **Decisions log.**
    - `docs/decisions-to-review.md` has § "2026-11-28 · Tab bar and Activity" with FEED-1 … FEED-32.
    - HOME-ADD-1 and GCS-7 are marked Changed.
    - HOME-ADD-2 stays Open.
58. **Before-production.** `docs/before-production.md` has these items, each added in the task that creates it:
    - the privacy of feed amounts is display-only (Task 1);
    - device-local seen state: badges are per device, lost on reinstall, and the 14-day first-run window (Task 2);
    - query cost and id-chunk URL length on hosted data (Task 2);
    - the Tabs badge is limited to the 20 bills `my_bills` returns (Task 7).

    Also: ADR 0025, the new concept note and the four concept updates exist, cite code by file and symbol, and the README row is added.

### User checks (handed to the user in the build summary; QA reports them "for the user")

How the phone reaches the backend: a dev build on an iPhone reaches Supabase only through the hosted project, or through the Mac's LAN IP with matching OAuth redirect URLs. If neither is set up, checks 59–60 are blocked until the deploy slice.

59. **User check (iPhone, light and dark):**
    - the raised (+) clears the home indicator;
    - the bar doesn't cover the last bill row;
    - VoiceOver reads "Activity, 3 new";
    - the largest text size doesn't clip the bar or the feed lines;
    - the amber, green and light-orange markers and the Groups-row hues read as light and calm in both appearances.
60. **User check (Activity on the phone):** open Activity, then open it again later, and confirm that lines you've already seen are no longer coloured and have no dot. Then open a bill from a line, come back, and confirm the Activity badge dropped that bill.
61. **User check (web, your browser):** sign in with Google on the local stack, land on Tabs, open `/activity` directly, and confirm that the browser's back and forward buttons move between tabs and pushed screens sensibly.

## Risks / open questions

All of these were decided without asking (the "build without blocking" rule) and are logged as FEED rows. **Needs your look** marks the ones that touch money, privacy or a design choice you might see differently.

- **FEED-1 Data source: client-side.** Built from existing RLS reads, with one pure rule function (`classifyFeedEvent`). This follows U11: a read function would hold the rule in SQL but isn't necessary for correctness or privacy (see FEED-27).
- **FEED-2 No bill names.** Captions say "Maya's bill", and sentences don't repeat the place.
- **FEED-3 The feed keeps history.** Unread lines get a coloured marker and a dot for one visit. The alternative is a feed of unseen items only. **Needs your look.**
- **FEED-4 Seen boundary.** A seen time equal to the item's time counts as seen.
- **FEED-5 Join time.** Each bill or group's feed starts at your `joined_at`.
- **FEED-6 Item edits that change your share** are matched by item name, because events store a name snapshot, not a row id. This can miss an item that was renamed and repriced at once.
- **FEED-7 The share is current,** from `computeShares`. It's left out in even mode until the bill is fully claimed, and when the bill read fails. The fully-claimed line shows your share. **Money: needs your look.**
- **FEED-8 One kind of undo isn't shown:** a sender undoing their own payment to you. The `unmarked_paid` event doesn't say who the payment was to. Fixing it means adding `payer_id` to that event in session 96's `unmark_paid`, which is a DB change, so it's deferred.
- **FEED-9 Group news.** Expense and receipt news show the expense amount, as in the user's example. They light the Groups dot but don't count toward the Activity badge. Group payments between other people never appear. **Privacy: needs your look.**
- **FEED-10 Milestones** are derived from loaded rows and the current state. They can disappear if the state goes back, and they never count.
- **FEED-11 "You were removed" lines are dropped,** because they need a stored record (U11). Once you're removed, the bill simply leaves your feed. Deferred.
- **FEED-12 Roll-up window:** 10 min (starting value).
- **FEED-13 Day headers:** the year shows only when it isn't the current year.
- **FEED-14 Page size:** 30 (starting value), with at most 3 fetch rounds per page. The end line reads "That's everything."
- **FEED-15 Home's heading:** stays `SplitIt`. The tab is "Tabs", with a receipt icon.
- **FEED-16 No Realtime on Activity.**
  - The Tabs badge refreshes when Home loads.
  - The Activity badge and Groups dot refresh on tab change, on foreground and after seen writes.
- **FEED-17 Groups dot:** others' group events except renames and link rotations, since you last opened the group on this device (or since you joined).
- **FEED-18 Hidden groups** are left out of the feed and the dot.
- **FEED-19 (+)** is a button in the tab bar, not a route, and it shows on web too. It supersedes HOME-ADD-1; HOME-ADD-2 stays open.
- **FEED-20 Groups-row hues (U10/U12).**
  - A claim row gets `warningSurface`.
  - A settled row gets `surfaceMuted` plus a check glyph, and highlighted rows get a pressed state at content opacity 0.7 (so the settled fill isn't mistaken for "pressed").
  - The design review's alternative: a plain settled row with only the check caption.
  - This reverses GCS-7. **Needs your look** (criterion 59).
- **FEED-21 Activity is marked seen** after its first page loads on each focus, so a failed load never clears anything.
- **FEED-22 Wording for a payment from you** recorded by the other person: "Ana marked $40.00 from you as received". **Copy: needs your look.**
- **FEED-23 Ordering ties.** `created_at`, then id. Within one transaction the order is stable from load to load, but it isn't insertion order (the CD-T8-2 limitation), because a sequence column would be a DB change.
- **FEED-24 Chip empty states:** "No money activity yet." / "No group activity yet." Money includes share changes and the settled milestones.
- **FEED-25 Profile links** from Settle and VenmoPrompt must bring you back. If a tab can't, a stack copy of Profile is the fallback.
- **FEED-26 Tabs badge** counts the bills Home lists, which is at most 20 (`my_bills`).
- **FEED-27 No migration (U11).**
  - Every read needed exists under RLS.
  - What was given up: an exact server-side "opened" time (replaced by device-local times), removal records (dropped), and the insertion-order tiebreaker.
  - Supersedes the earlier "no DB changes at all" wording. Migrations stay allowed when they're genuinely necessary for correctness or privacy; none is here.
- **FEED-28 Bills also get a device-local "opened" time,** written where `markBillSeen` already runs. `bill_seen` keeps driving Home's "New" markers. The coordinator asked to use `bill_seen`, but its time isn't readable by clients. **Needs your look.**
- **FEED-29 First run:** with no stored Activity time on this device, anything older than 14 days counts as seen (starting value), so a new phone doesn't start at "9+".
- **FEED-30 Seen times are per device and per user** (key `splitit.feedSeen.<userId>`). They're kept across sign-out and lost on reinstall. **Needs your look.**
- **FEED-31 Final marker design (U12):**
  - colour only while unread;
  - a dispute is light orange (`disputeSurface` / `dispute`, new tokens);
  - neutral for everything else and for every read line;
  - an 8-pt `primary` unread dot.
- **FEED-32 Roll-up lines** use `users-round`. The design review listed no glyph for roll-ups.

Other risks:
- **R1 Privacy is a display rule, not a security boundary.** Participants can already read every event and amount through RLS (the per-bill Activity screen shows them). The feed only chooses not to show others' payments. A before-production item asks whether that's acceptable before real users.
- **R2 Read cost.**
  - The feed and the badges read events across all your bills and groups in chunks.
  - The badge read is bounded by the last Activity visit or the 14-day floor.
  - It's unmeasured on hosted data, and the URL length with 100 ids per chunk needs a check. Before-production item.
- **R3 Badges are per device** (FEED-30). On a second phone everything from the last 14 days shows as unread once.
- **R4 Shared tests.** Task 6 rewrites assertions in tests session 92 wrote. Announce the files to 92, and grep tests and fixtures for each changed label first.
- **R5 Expo Router specifics** are marked "verify" in Task 5: `unstable_settings`, `/groups` alongside `/groups/[id]` across a tabs group and the stack, and pushing `/profile` from a screen above the tabs. Criteria 31–34 and 41 state the behaviour, not the mechanism.

## Amendment A1 (2026-11-28, review by splitit-app-92)
- **A1.1 max_rows truncation (Tasks 2 and 7):**
  - Every chunked read over `bill_events` / `group_events` gives an explicit `order` and a `limit` no larger than the hosted max_rows (1000).
  - A page that comes back full means "maybe more", never "everything".
  - "That's everything." shows only after a short page. Badge inputs built from a full page count as "at least" (the badge rounds up to "9+", never down).
  - New criterion A1.1: a fixture returning exactly `limit` rows must not show "That's everything." and must ask for the next page.
- **A1.2 Task 6 mocks:**
  - Keep the `jest.mock('@/lib/homeSections', … HOME_SECTIONS_START_CLOSED: [])` blocks in homeLayout, homeMarkers and shareAndJoin. The homeLayout "HOME-SEC-2 (amended)" test keeps importing `HOME_SECTIONS_START_CLOSED` from the mocked module.
  - New router tests that read Home rows (`__tests__/tabBar.test.tsx`) use the same mock, or press the section toggles.
- **A1.3 Criterion 35 made exact:**
  - `tabsBadgeCount = claim.length + pay.length + owed.length` from `homeSections()`, each bill once. The count is independent of which sections are open or closed.
  - `waiting` is never added, since it holds the same rows as claim + pay.
  - Test: one bill in claim, one in pay and one in owed gives a badge of 3.
- **A1.4 The tab label "Tabs":** the user chose it explicitly on 2026-11-27 (asked against "Bills", "Splits" and "Home"). Log it as a FEED row; no change.
- **A1.5 FEED-26:** `my_bills` returns at most 20 bills, so the Tabs badge can undercount for heavy users. Added to `docs/before-production.md` by Task 12.
- **A1.6 Criterion 32(d):** a notification tap while the app is open on a non-Tabs tab (warm start on Activity or Groups). Back returns to that tab. The test covers a warm start on Activity.

## Amendment A2 (2026-11-28, coordinator, after Task 1)
- **A2.1 F-k also covers a removed claim (Task 1):** an `item_changed` whose `details.removed_claimer_ids` lists me (a quantity drop that removed my claim) is a share change, though I no longer claim the row. It's included as F-k (share, counts, no amount, C13 wording), whatever the row's name. A malformed `removed_claimer_ids` (not a list of uuids) excludes the event. Tested in `lib/feedRules.test.ts` with the `itemChangedRemovedMe` (met) and `itemChangedRemovedSam` (unmet) fixtures in `test-utils/feedFixtures.ts`.
- **A2.2 (2026-11-28, Task 4) Negative shares show no clause:** `feedShareCents` (`lib/feedShare.ts`) returns null when my current share is negative (a claimed discount bigger than my items), so C10–C15 have no share clause and C23 no share part. feedText refuses negative amounts as well. Tested in `lib/feedShare.test.ts`.
- **A2.3 (2026-11-28, Task 4) Criterion 22's C23 case, as read:** an even-mode bill with an unclaimed item isn't complete, so the fully-claimed line (C23) doesn't appear at all, which is stricter than "no share part". The "no share part" form is tested on a complete bill where I claim nothing (`lib/feedView.test.ts`).
- **A2.4 (2026-11-28, Task 4) Field names:** `classifyFeedEvent` gives `amounts_changed` fields by name (`tip`, `tax`, `fees`, `discount`, `total`), and feedText's C10 reads key names. `lib/feedView.ts` converts them (`tip_cents`, `tax_cents`, `fees_cents`, `discount_cents`, `total_cents`); neither feedRules nor feedText changed for it.
- **A2.5 (2026-11-28, coordinator, Task 4) All square is my own balance:** the milestone is kept when the bill is complete and my balance (settle's `balanceFor` on the `ledgerSettlePlan` plan Home and Settle build) is settled up within `isSettledUp` (1¢) on both what I owe and what I'm owed. It no longer uses Home's settled/hidden grouping, so a guest who has paid their share gets it, and so does a payer whose owed amounts are all marked paid. Supersedes "Kept only if `homeRowView(...)` puts the bill in `settled`" in Contract F and criterion 23. Tested in `lib/feedView.test.ts` (guest paid, guest 1¢ / 2¢ short, guest unpaid, incomplete bill, payer settled, payer owed).

## Amendment A3 (2026-11-28, Task 11 live reconciliation)
- **A3.1 Result:** 58/58 against the local stack (users Maya, Sam, Ana, Me, outsider Dee; one group, six bills). Every Contract A read succeeded under RLS with the spec's column names: `bill_participants (bill_id, joined_at)` with an exact count, `bills (id, host_id, group_id, created_at)`, `my_groups()` (`joinedAt`, `hidden`), `bill_events (id, bill_id, actor_id, kind, item_name, details, created_at)`, `group_events (id, group_id, actor_id, kind, details, created_at)`, `profiles (id, display_name)`, `group_payments (id, from_user, to_user, cents)` (an undone row too), `fetchSettleData` and `fetchGroupSnapshot`. The keyset `.or(...)` with an ISO `Z` cursor and microseconds works. No contract mismatch with Contracts A, F or G.
- **A3.2 C10 on a tip edit (wording, for the user):** `update_bill` puts `total_cents` in `amounts_changed.details` whenever the tip, tax or fees change, because the total changes with them. So a tip edit reads "Maya changed the tip and the total. Your share is now $5.00", never "Maya changed the tip". This follows C10 as written, and no code changed. Whether to drop "the total" when another field is listed is a wording decision for the user.
- **A3.3 Ties:** a real tie inside one source was produced and checked live. One `update_bill` wrote `item_changed` and `amounts_changed` with the same `created_at`. Both came out adjacent, in id-desc order, and walking the feed one row per page skipped and repeated nothing. A tie across the two sources can't be produced live: no single call writes a read kind to both `bill_events` and `group_events` (attach writes `bill_added` and `moved_to_group`, and `moved_to_group` isn't read). The cross-source tie order is covered only by unit tests (`compareFeedRows`).
