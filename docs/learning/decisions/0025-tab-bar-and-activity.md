# 0025: Tab bar and Activity feed

**Status:** Accepted (2026-11-28, spec `docs/specs/2026-11-28-tab-bar-and-activity.md`, Amendments A1–A3). Tasks 1–11 are built. The live check against the local stack passed 58 of 58 (A3.1). On 2026-11-28 the user looked at the web app and approved the visuals as built (the "User visual review" note after the FEED table in `docs/decisions-to-review.md`). Decisions FEED-1 onward are logged there (FEED-47 was the last on 2026-11-28), and the ones marked "needs your look" or "your call" are still open. The phone checks (spec criteria 59–61) are for the user and were not run here.

*Numbering note:* 0025 was reserved with a stub on 2026-11-28 by the spec's Task 0. This file fills that stub in place.

## Context
Before this change, Home did three jobs. It listed your bills, it had a Groups block and two header icons (Groups, Profile), and it had a sticky "Add receipt" bar at the bottom (HOME-ADD-1). There was no single place to see what other people had done that involves you. You found out that Maya added you to a bill, or that Sam marked $18.20 paid to you, only by opening each bill's own Activity screen.

The user designed the fix (spec U1–U12):
- a bottom tab bar with five slots: **Tabs · Groups · (+) · Activity · Profile**;
- badges on it that say what needs you;
- one **Activity** timeline of things that involve you, across every bill and group.

### What the user decided (2026-11-27/28)
- **"Tabs" is the label** for the first tab (today's Home). The user picked it on 2026-11-27, over "Bills", "Splits" and "Home" (A1.4). The heading on the screen stays `SplitIt` (FEED-15).
- **Five tabs**, with (+) as a raised button in the middle (U1).
- **No database changes for "seen" state** (U11). The user first said "dont make db changes / if we need to store new values/columns dont do it", then clarified: "i didnt mean a blanket no on db migration - i just didnt want two last seen fields and stuff like that". So: no `group_seen` or `activity_seen` tables, no other per-user tracking state in the database, and a migration only if it's truly needed for correctness or privacy.
- **Light hues, and colour only while unread** (U12, FEED-31). A line's marker is coloured only until you've seen it. A dispute is light orange ("give it a light orange"), because red stays for app errors.
- **Groups-list rows get a small hue** in two cases only: you need to claim, or the group is settled (U10). This reverses GCS-7.

## Options
| Question | Options considered | Chosen |
|---|---|---|
| Where the feed is built | A security-definer read function `my_activity` in SQL; **on the phone, from reads RLS already allows** | On the phone, with one pure rule function (FEED-1) |
| Where "seen" lives | New tables (`activity_seen`, `group_seen`); read `bill_seen.seen_at`; **a timestamp store on the device** | On the device, per user (FEED-28, FEED-30) |
| Tie order for events with the same time | A new `seq` column; **`created_at`, then event id** | `created_at`, then id (FEED-23) |
| "You were removed" lines | A notices table; **drop them** | Dropped for now (FEED-11) |
| What (+) is | A dummy route; **a button in the tab bar** | A button that pushes `/scan` (FEED-19) |
| Dispute colour | Red (`danger`); **a new light orange pair** | `disputeSurface` / `dispute` (FEED-31) |
| Settled group row | A plain row with a check caption; **a grey fill plus a check** | Grey fill plus check, with a different pressed look (FEED-20) |

## Decision

### 1. The tabs sit under every other screen
`app/(app)/(tabs)/_layout.tsx` is an Expo Router `Tabs` navigator with our own bar (`LiveTabBar` in `components/TabBar.tsx`). Home, Groups, Activity and Profile are its four routes. Everything else (a bill, a group, `/scan`, the new-bill form, `/account`) is pushed on the `(app)` stack **above** the tabs, so it shows without the bar.

Three pieces keep Back working on every route (criteria 31–34):
- `unstable_settings = { initialRouteName: '(tabs)' }` in `app/(app)/_layout.tsx`. A cold deep link to `/bills/<id>` builds a history with the tabs underneath, so Back reaches Tabs.
- `router.replace(..., { withAnchor: true })` in `app/b/[code].tsx` and `app/g/[code].tsx`. After joining by link, the bill or group opens with the tabs below it.
- `backToTabs` in `lib/tabsNav.ts`. "Home" on a pushed screen pops back to whichever tab you came from, instead of always jumping to Tabs.

(+) is not a route. It's a button in the bar that pushes `/scan`, with a ref guard so a double tap pushes once. Profile's Venmo links from Settle and `VenmoPrompt` open `/account` (`app/(app)/account.tsx`), a copy of Profile with a Back header, so one Back returns you to Settle (FEED-25).

Details: [auth and deep links](../concepts/auth-and-deep-links.md), "Tabs under the stack".

### 2. The feed is built on the phone, with one rule function
The Activity screen reads `bill_events`, `group_events`, `bill_participants`, `bills`, `my_groups()`, `profiles` and `group_payments`. RLS already lets you read all of these. Then **one** pure function, `classifyFeedEvent` in `lib/feedRules.ts`, decides for each event:
- is it in your feed at all;
- its category (needs you, money, dispute, share change, news, roll-up);
- does it count toward the badge;
- which amount, if any, may be shown.

The screen, the badges and the live check all call it. Nothing else filters events. Paging is keyset paging over the two tables, merged on the phone (`fetchFeedPage` in `lib/activityFeed.ts`).

Details: [activity feed and badges](../concepts/activity-feed-and-badges.md).

### 3. "Seen" is stored on the device
`lib/feedSeen.ts` keeps one value per signed-in user, under the key `splitit.feedSeen.<userId>`. It holds only timestamps: when you last opened Activity, each bill and each group. An item counts as seen if you opened its bill, its group or the Activity tab at or after the time it happened (`isFeedItemSeen`). Anything older than 14 days always counts as seen (`FEED_FIRST_RUN_DAYS`, FEED-29, FEED-34), so a new phone doesn't start at "9+".

`bill_seen` (the server table) still drives Home's "New" markers. It couldn't be reused here: clients can't read its `seen_at`, and `my_bills()` returns only a yes/no (FEED-28).

### 4. No migration, and what that cost
Every read the feed needs already existed (spec "Why no migration", FEED-27). What was given up:
- **An exact server "opened" time.** Device-local times replace it. So badges are per device and are lost on reinstall (R3).
- **"You were removed" lines.** They'd need a stored record. Once you're removed, the bill just leaves your feed (FEED-11).
- **Insertion order for ties.** Two events with the same `created_at` sort by id. That order is stable from load to load, but it isn't the order they were written in (FEED-23).
- **One kind of undo isn't shown:** a sender undoing their own payment to you, because that event doesn't say who the payment was to (FEED-8).

### 5. Privacy here is a display rule, not a security boundary
The feed shows an amount only for your own money: "Sam marked $18.20 paid to you". It never shows what two other people paid each other. But RLS lets every participant read every `bill_events` row, amounts included, and the per-bill Activity screen already shows them. So this rule only decides what the feed *chooses* to show. A script could still read those amounts. This is risk R1, tracked in `docs/before-production.md` §4.

### 6. Badges
- **Tabs:** the number of bills that are waiting on you or owed to you (`tabsBadgeCount` in `lib/tabBadges.ts`: claim + pay + owed, each bill once, A1.3). It counts only the bills Home lists, which is at most 20 (`my_bills`, FEED-26, A1.5).
- **Groups:** a dot when someone else did something in one of your groups (not a rename or a link change) since you last opened it on this device (`groupsDot` in `lib/feedRules.ts`).
- **Activity:** the number of bills or groups with unseen items that count (`activityUnreadCount` in `lib/feedRules.ts`). `badgeText` turns 10 or more into "9+".

### 7. Colours (U10, U12)
- Feed markers are coloured **only while unread** (`feedMarkerTone` and `FEED_MARKER_TONES` in `lib/feedText.ts`): amber for "needs you", green for money, light orange for a dispute. Everything else, and every line you've seen, is neutral grey. Each line keeps its icon, so meaning never depends on colour.
- Two new tokens in `lib/theme.ts`: `disputeSurface` and `dispute` (light `#FFF6ED` / `#C4320A`, dark `#3A1D0B` / `#FDBA8C`). `lib/theme.test.ts` checks they reach at least 4.5:1.
- Groups-list rows: a claim row gets `warningSurface`, a settled row gets `surfaceMuted` plus a check (`ListRow`'s `highlight` prop, `'warning'` or `'muted'`). Because `surfaceMuted` is also the plain row's pressed colour, a tinted row shows "pressed" by dimming its content to `opacity.pressed` (0.7) instead.

Details: [design system](../concepts/design-system.md), section 11.

## Consequences
- **Good:** no new tables, columns or functions, so nothing new to secure or migrate. Every rule about what's in the feed is in one tested function. Home is simpler (no sticky bar, no Groups block).
- **Bad:** badges are per device (R3). The feed and badge reads scan your events across all your bills and groups in chunks, and that cost hasn't been measured on hosted data (R2). Seen times use the phone's clock and event times use the server's, so a phone set far off can leave badges stuck or skip new items (review R3). All three are in `docs/before-production.md` §4.
- **Bad:** the Tabs badge can undercount for someone on more than 20 bills (A1.5).
- **Reversible:** if seen state needs to follow you across devices, a later ADR can add a server table. The rule function and the device store are the only places that would change.

## Related
- Spec: `docs/specs/2026-11-28-tab-bar-and-activity.md`.
- Decisions: FEED-1 onward in `docs/decisions-to-review.md` ("2026-11-28 · Tab bar and Activity"), plus the "User decisions (2026-11-27/28)" note there.
- Supersedes HOME-ADD-1 (the sticky "Add receipt" bar) and GCS-7 (no hue on group rows). Neither was an ADR.
- [ADR 0010](0010-on-device-ocr-no-custom-backend.md): no custom backend, which is why there's no push and the badges are in-app only.
