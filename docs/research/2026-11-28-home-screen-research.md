# Home screen research: how a bill-splitting app's main list should look

Date: 2026-11-28. Purpose: inform the redesign of SplitIt's Home tab (`app/(app)/(tabs)/index.tsx`), which now sits under a bottom tab bar (Tabs · Groups · + · Activity · Profile).

**How this was researched.** I used web search and page fetches against competitors' App Store listings and reviews, official blogs and help centres, open-source code (Spliit), news coverage, and design guidance (Apple HIG, NN/g, Laws of UX, W3C, UXmatters). **Limits:** Reddit refuses this research agent's fetcher, so no Reddit threads are quoted. Material 3's site renders only with JavaScript, so its list guidance comes from Android's Compose docs. App Store pages show only a handful of recent reviews. Some details of Splitwise's screens come from 2017–2021 sources and may have changed. The only numbers given here are ones a source states.

**SplitIt's starting point** (from `lib/homeSections.ts`, `lib/homeMarkers.ts`, PRODUCT.md and DESIGN.md):
- Each row has a title ("Your bill" / "Sam's bill"), a caption ("Nov 26 · 3 people"), one status pill (about 20 variants, e.g. "Nothing claimed yet", "Not received · $12.40", "2 people left to pay", "Settled up") and one amount with a label ("Your share", "To collect" or "Total").
- Groups: `claim` (Items to claim), `pay` (Still needs to be paid), `owed` (Owed to you), `settled` and `hidden`. Home loads the 20 newest bills.
- Today every section starts collapsed, so the screen shows four headings and no bills.

---

## 1. Executive summary: the top 5 findings

1. **Every serious competitor puts the money first, not a list of headings.** Splitwise shows a balance banner ("you owe / you are owed / total") at the top of Home [S1][S3]. Its Android 5.0 redesign gave "more real estate to group/friend balances" so people "always know their total balance" [S2]. Spliit's group list starts with a "Your total balance" card ("You are owed" / "You owe" / "You are all settled up across your groups") [S8]. SplitIt's Home today has no summary at all.
2. **Collapsed sections hide exactly what users need.** NN/g: "When content is hidden, people might ignore information"; accordions "should be avoided when your audience needs most or all of the content on the page"; "essential information should be presented outside of accordions" [P1][P2]. Apple's HIG: "Place controls that people are most likely to use at the top of the disclosure hierarchy so they're always visible" [P5]. On Home, the bills waiting on you are the essential content, and all four sections start collapsed. This is the main reason the screen "doesn't look good" and also the main usability problem.
3. **Rarely needed things get archived or folded away, not given equal headings.** Tricount puts archived tricounts behind one link at the bottom of the list [C4]. Settle Up archives "old, inactive groups" off the main screen [C6]. Spliit has Starred / Recent / Archived [S8]. Splitwise hides old expenses after you settle up, behind a checkmark [C2]. In every case the finished items take one quiet line at the bottom, which is how SplitIt should treat Settled.
4. **Users praise simplicity and complain about paywalls, lost detail and redesigns that add noise.** Splid reviews: "Really simple and easy without any fussiness" [C7]. Splitwise reviews and coverage are dominated by anger at the daily expense cap and the paywall ("paywalled nearly everything useful") [C1][C3]. After Tricount's redesign, users reported "intrusive icons and a less clear layout" (third-party summary) [C5]. Tab users want to "get back to the details" of a past split [C9]. So the lessons for Home are: keep history reachable, show no upsell, and add no decoration.
5. **For 1–30 bills, a summary header plus one or two open, sorted lists beats tabs, accordions and people-centric views.** NN/g says tabs are wrong when people need to see items across tabs, and non-default tabs must hold only "supplemental content" [P3]. Hick's law: fewer choices mean faster decisions [P7]. People-centric balances (Splitwise's Friends tab) suit ongoing roommate ledgers. SplitIt's bills are one-off, settled per bill on Venmo, and Groups already has its own tab. **Recommendation:** a two-figure summary, a "Needs you" list that's always open, an "Owed to you" list that's open and shows up to 5 rows plus "See all", and Settled as one row at the bottom.

---

## 2. Competitors

| App | What Home leads with | Grouping | Where the actions are | What users praise / dislike | Sources |
|---|---|---|---|---|---|
| **Splitwise** | A balance banner: money owed to you, money you owe, and the total, "displayed prominently in a banner near the top" (2017 critique). Android 5.0 (2021) made **Groups** the default first tab and gave "more real estate to group/friend balances". | Bottom tabs: Groups · Friends · (+) · Activity · Account. Each row is a group or a friend with its balance; groups use rounded rectangles and friends use circles. The header can "persist a filter", e.g. only friends with outstanding balances (2019). Old expenses are hidden after you settle up. | A green centre **(+)** for adding an expense; the 2017 critique called discoverability "excellent". Settle up is inside a group or friend. | Praise: "Alot of thought and polish has gone into it". Dislike: the daily expense cap and paywall ("paywalled nearly everything useful", "charging users for absolutely everything drove each and every one of my friends away"); "You can't see who owes what across your group. Only what people owe you." A student case study found the Friends screen "provides little information" and that a user struggled to find who owed the most. | [S1] [S2] [S3] [C1] [C2] [C3] [C10] |
| **Splitwise Itemize** (Oct 2026) | It's a flow, not a home screen: one person photographs the receipt, friends join by QR "without downloading anything or creating an account first", and everyone selects their own items; tax and tip are split proportionally. | The result can be added "to an ongoing Splitwise balance". | — | This is SplitIt's closest competitor now (free in the US and UK). Home is where SplitIt can feel calmer than Splitwise's dense ledger. | [C11] |
| **Tricount** (bunq) | A list of tricounts (the 🏠 tab). Inside a tricount: expenses, plus a Balances screen with suggested reimbursements and "My Total". | Sorted by creation date (the developer said a new sorting was being considered). Archived tricounts sit behind a link at the bottom of the list. | Long-press to archive. Reimbursements are marked paid on Balances. | Praise: "This app makes it so easy." Dislike after the 2024 redesign: "confusing and less intuitive, with intrusive icons and a less clear layout" (third-party summary of Play reviews); lost features; sync and data-loss reports. One wanted a "big picture view of the expenses". | [C4] [C5] [C12] |
| **Settle Up** | "My groups" list. Inside a group, circles show each member's balance, and "The person with the biggest debt in the middle should pay next." | Groups; archive for "old, inactive groups". | Tap a member's circle to start an expense with them as payer. Reviewers rate this "the fastest expense adding framework". | Praise: "very slick interface, all required details are easily available"; sharing without sign-up. | [C6] [C13] |
| **Splid** | A group list; inside a group, expense and summary tabs and "who owes whom". | Groups. Expenses are shown "in the order they're logged". | Add expense inside a group. | Praise: "incredibly straightforward and simple", "clean and intuitive interface", "without any fussiness". Dislike: wants sorting in the expense tab. Paid upgrades (Splid Plus, extra groups) drew no complaints in the visible reviews. | [C7] |
| **Spliit** (open source, PWA) | A **"Your total balance"** card ("Your combined balance across all your groups": "You are owed" / "You owe" / "You are all settled up across your groups"), then the group lists. | **Starred**, **Recent** and **Archived** groups. Expenses are grouped by date: "This week", "Earlier this month", "Last month"... Empty state: "You have not visited any group recently. Create one … or ask a friend to send you the link". | "Create group" and "Add by URL" (paste a link or scan a QR). | Directory and AlternativeTo listings mostly praise it for being free and open source. A fork's pull request adds a per-friend balances view across groups. | [S8] [C14] |
| **Venmo** | A **feed**. The 2021 redesign removed the global feed, leaving the friends feed, with a bottom bar for feed / products / profile. The 2026 redesign starts with Home and a richer feed ("Pay Again", "Say Thanks", offers). "Send" and "Money" tabs were due over the following months. | Pending requests and payments sit under **Me → Transactions**, "at the top of the feed" in a "Pending" section. | Pay/Request is a central action. Research found many users "have no idea" features exist. | The old contacts screen was "a black-and-white list of individual contacts and names crowding the screen". | [V1] [V2] [V3] [V4] |
| **Cash App** | Money first: the official press describes a streamlined **Money tab** for "a snapshot of their finances within seconds". (Third-party guides say the balance is at the top with activity below; Cash App doesn't document this.) | A separate activity log. | A keypad / pay flow. | — (no reliable review data found) | [V5] |
| **Tab** (bring10) | A one-off bill flow: photograph the receipt; others "join the bill and select their own items", synced live. | Per bill. | — | Praise: it split "between seven people fairly easily". Dislike: "could not get back to the details to verify that we had split the bill correctly, adding some audit trail would be really useful". The scanner added a tip and included subtotal/tax as line items. | [C9] |
| **splitty** | A one-off bill flow: scan, assign items, choose the tip, Venmo request. | Per bill. Per person: "tap on a person to launch a breakdown of everything they owe" (developer reply). Settings sit under "home > settings". | Scan from Home. | Praise: "so straightforward & user interface is easy to navigate". Asked for: contact search. | [C15] |
| **Plates by Splitwise** | An older single-meal tool: "drag them right on to people's plates" and "Split the rest" evenly. | — | — | A competitor's marketing page says it hasn't been updated in years (not verified). | [C16] |

**What the pattern shows.**
- **Ledger apps** (Splitwise, Spliit, Tricount, Settle Up, Splid) lead with a **balance** and a list of **containers** (groups or friends).
- **Payment apps** (Venmo, Cash App) lead with a **feed** or **balance**, with pending items one level down.
- **One-off receipt apps** (Tab, splitty, Itemize) mostly have no Home worth the name. What users miss there is history: "get back to the details".

SplitIt sits between ledger and receipt apps: every bill is one-off, but people come back to Home for days to see who still owes. Ledger apps' "balance first" is therefore the right lead for SplitIt's Home, with a bill list in place of their friend or group list.

---

## 3. Principles, with sources

**Summary first.**
- NN/g's inverted pyramid: put "the most important information (or what might even be considered the conclusion)" first, so "Readers can stop reading at any point on the page and still come away with the main point" [P8].
- In NN/g's 2018 study, users spent "about 57% of their page-viewing time above the fold". Advice: "Reserve the top of the page for high-priority content" [P9].
- For SplitIt, the answer to "what do I owe and what am I owed" belongs at the top.

**Scanning and the F-pattern.** People sweep across the top, then down the left edge. "Start headings and subheadings with the words carrying most information", "Front-load" and "Cut unnecessary content" [P4]. For rows:
- The left edge carries the *who* (host name).
- The right edge carries the *how much*. Money right-aligned in a column is easy to compare down the list, which is DESIGN.md's Receipt Column Rule.
- The status line should start with its verb ("Pay Sam", "Claim your items").

**Accordions and collapsed content.**
- Accordions fit when "users need only a few pieces of information on the page".
- Collapsed content "may be missed altogether".
- "essential information should be presented outside of accordions".
- If accordions are used, "Allow users to open or collapse multiple sections at a time" and give headings that describe what's inside [P1][P2].
- Apple: put the most-used items at the top of the disclosure hierarchy "so they're always visible", with advanced material hidden [P5].

The bills that need the user are the essential content, so they must not sit inside a collapsed section.

**Progressive disclosure.**
- "Initially, show users only a few of the most important options", and "You must get the right split between initial and secondary features".
- "designs that go beyond 2 disclosure levels typically have low usability" [P6].

For Home, level 1 is the open lists and level 2 is "See all" or Settled. Don't add a third level.

**Tabs and segmented controls.**
- NN/g: avoid tabs when users must "simultaneously see information presented under different tabs". Nondefault tabs should hold supplemental, not critical, content. "The fewer tabs, the better" [P3].
- Apple's segmented control is for "closely related choices that affect an object, state, or view", with at most about five segments on iPhone [P10].

A "To pay / To collect" switch would hide one of two equally important lists.

**Tab bars (Apple HIG).**
- "Use a tab bar to support navigation, not to provide actions."
- Keep it visible.
- "If a section is empty, explain why its content is unavailable."
- "Reserve badges for critical information" [P11].

SplitIt's centre (+) is an action in the bar. That breaks the HIG's letter, but it follows Splitwise's long-standing green (+), which a critique praised for discoverability [S1]. Keep it. Because it's the one primary action, Home must not repeat a competing "Add receipt" button, except in the empty state, where the HIG and NN/g both ask for a direct path.

**Lists (Apple HIG, Material).**
- "Keep item text succinct so row content is comfortable to read". If rows grow, "list item titles only, letting people choose an item to reveal its content in a detail view" [P12].
- Material's list item has a headline, supporting text (one to three lines) and trailing meta content [P13].
- A two-line row (title, then caption with status) with a trailing amount is the standard shape on both platforms.

**Hick's law.** "The time it takes to make a decision increases with the number and complexity of choices"; "Avoid overwhelming users by highlighting recommended options". Caveat: "Be careful not to simplify to the point of abstraction" [P7].
- Today's Home offers four Show/Hide toggles before any bill appears.
- About 20 different pill strings also mean the user must interpret each row.

**Thumb and touch (Fitts, Hoober).**
- Fitts: targets should be large, spaced, and "placed in areas of an interface that allow them to be easily acquired" [P14].
- Hoober's 2013 field observation of 780 people touching their phones: 49% one-handed, 36% cradled, 15% two-handed. He later retracted his thumb-reach drawings ("Please, please everyone ignore those drawings") [P15].
- His 2017 work: people "prefer to view and touch the center of the screen". Put primary content in the centre, put secondary actions such as tabs along the top and bottom edges, and put tertiary items in corner menus. Targets at edges need to be larger [P16].

So: rows are the main targets and should be full-width. The (+) in the bottom bar is well placed. Rare actions (filters, settings) belong in a top corner.

**One primary action.**
- PRODUCT.md principle 3: "One obvious next step per screen".
- Splitwise's single green (+) among grey tabs [S1] is the market version of this.

On Home, that one action is (+), and each row's own next step ("Pay Sam $18.40") lives on the bill screen, not as a button in the list.

**Showing money.**
- Use tabular figures: MDN describes `tabular-nums` as figures "all of the same size, allowing them to be easily aligned like in tables" [P17].
- Never use colour alone. WCAG 1.4.1: "Color is not used as the only visual means of conveying information" [P18]. Apple: "Avoid relying solely on color to differentiate between objects … or communicate essential information" [P19]. Colour blindness "affects approximately 1 in 12 men (8%) and 1 in 200 women", most often red/green [P20], which is exactly the owe/owed pair finance apps reach for.

So "You owe" / "You're owed" must be said in words. A minus sign alone is also easy to miss, so use the word.

**Empty states.**
- NN/g: "Totally empty states cause confusion"; empty states should give status, a learning cue, and "direct pathways … to getting started" [P21].
- Spliit's "Create one … or ask a friend to send you the link" [S8] is a good model because it covers both of SplitIt's ways in: hosting a bill and being invited to one.

---

## 4. Pattern comparison for 1–30 bills

| Pattern | Pros | Cons | Evidence |
|---|---|---|---|
| **(a) Summary header + one sorted list** | Answers the main question in one glance. Inverted pyramid. Used by Splitwise, Spliit and Cash App. Very calm. | One mixed list makes people read each row's status to see whether it's theirs to act on, and claim, pay and collect rows interleave. The sum must be honest when some shares are unknown. | [S1][S2][S8][P8][P9] |
| **(b) Segmented tabs (To pay / To collect / All)** | Short lists; familiar control. | Hides one of two equally important lists (NN/g: nondefault tabs only for supplemental content). It adds a second navigation layer right under the bottom tab bar. Counts in the segments become the only clue to hidden bills. | [P3][P10] |
| **(c) Open sections, first N rows + "See all"** | Everything important is visible. Sections give the mini-structure NN/g says helps on mobile. Long tails stay short. Two disclosure levels at most. | Four or more section headings can still feel busy, and empty sections must disappear rather than say "(0)". | [P1][P2][P6] |
| **(d) Needs-action card stack + recent list** | Makes "what to do now" very loud. | Cards for every pending bill turn into a pile at 5+ bills. Card chrome competes with the money (against DESIGN.md's flat, hairline style). It duplicates the Activity tab's job. Venmo found people don't discover features when the screen is busy. | [V4], DESIGN.md |
| **(e) People-centric balances** | Ideal for ongoing ledgers (roommates). Splitwise's Friends tab is built on this. | SplitIt settles **per bill** through a pre-filled Venmo link per bill. Netting across bills would break "Fair to the cent" per-bill accounting and the "I paid" marks. Bills have no titles, so people would be the only handle. Groups already has a tab. | [S2][C10], PRODUCT.md |

**What fits 1–30 bills:** combine **(a) + (c)**. Put the summary on top. Below it, show at most two open lists, grouped by who has to act (you, or others), with each list capped and a quiet "See all". Settled goes into a single closed row. At 1–5 bills nearly everything is visible with no taps. At 20–30 bills (Home's current 20-bill window) the caps keep the first screen to roughly two short lists.

---

## 5. Recommendation for SplitIt's Home

### Layout (ASCII mockup, typical state)

```
┌──────────────────────────────────────────┐
│ Bills                                    │  ← title (22/700), no "SplitIt" wordmark
│                                          │
│ ┌──────────────────┐ ┌─────────────────┐ │
│ │ You owe          │ │ You're owed     │ │  ← summary: two quiet tiles,
│ │ $36.20           │ │ $112.40         │ │    words + figure, tabular, ink
│ │ on 2 bills       │ │ on 4 bills      │ │    (no red/green fill)
│ └──────────────────┘ └─────────────────┘ │
│ + 1 bill to claim before your share is   │  ← honesty line (only when needed)
│   known                                  │
│                                          │
│ NEEDS YOU                                │  ← section label (13/600, muted)
│ ┌──────────────────────────────────────┐ │
│ │ (S) Sam's bill              $78.60 › │ │  title · trailing amount
│ │     Claim your items         Total   │ │  status (teal) · amount label
│ │     Nov 26 · 3 people                │ │  caption (muted)
│ ├──────────────────────────────────────┤ │
│ │ (P) Priya's bill            $18.40 › │ │
│ │     Pay Priya              Your share│ │
│ │     Nov 24 · 5 people                │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ OWED TO YOU                              │
│ ┌──────────────────────────────────────┐ │
│ │ (Y) Your bill               $42.00 › │ │
│ │     2 people left to pay   To collect│ │
│ │     Nov 25 · 4 people                │ │
│ ├──────────────────────────────────────┤ │
│ │ ... up to 5 rows ...                 │ │
│ ├──────────────────────────────────────┤ │
│ │ See all 10                         › │ │  ← only when > 5
│ └──────────────────────────────────────┘ │
│                                          │
│ ✓ Settled · 1 bill                     › │  ← one quiet row, no card
│                                          │
├──────────────────────────────────────────┤
│  Bills   Groups    (+)   Activity  Profile│  ← bottom tab bar (the main action)
└──────────────────────────────────────────┘
```

### Order of elements, and what's visible by default
1. **Title "Bills"** (or keep "SplitIt" only if the user wants the brand; a noun says where you are, matching the tab label). No other header icons, since Profile and Activity are tabs now. Add a corner filter later only if it's needed (Hoober: tertiary items go in corners).
2. **Summary tiles: "You owe $X" and "You're owed $Y".**
   - Sum only amounts the plan knows: `balanceFor(...).owesCents` and `stillToCollectCents`. These are integer-cent sums of per-bill figures that are already exact, so no rounding is involved.
   - Under each figure, say how many bills it covers.
   - When some bills have no known share yet (nothing claimed, or no plan), say so in words: "+ 1 bill to claim before your share is known". This follows "Honest about what we know".
   - If both sums are $0 and there are no open bills, replace the tiles with "You're all settled up" (✓ icon plus words).
   - Tap a tile to scroll to its section; it adds no new screen.
3. **"Needs you"**: always open, every row shown (it's rarely long).
   - It merges today's "Items to claim" and "Still needs to be paid".
   - Sort claim rows first: they're time-critical at the table, and the friend can't pay until they claim. Then sort pay rows, newest first.
   - Hide the section entirely when empty; never show "(0)".
4. **"Owed to you"**: open, the first 5 rows newest first, then "See all N" (a push to a full list, or expanding in place).
   - Collecting money is the host's whole reason to return, so it's open. It's capped because it's the list that grows.
   - The cap of 5 is a starting value to tune, not a sourced number.
5. **"Settled · N bills"**: one row at the bottom with a check icon. It opens the settled list (Tricount's "Archived" link pattern, Splitwise's hidden-after-settle pattern). The "Bills you've paid don't show here" note goes inside that screen, not on Home.
6. The **"added you to a bill" notice** and the **Venmo prompt**, when present, sit between the summary and "Needs you", one at a time. They should never push the lists below the fold together.

### Row anatomy (one row = one bill, 56 pt minimum)
- **Leading:** a 32 pt avatar with the host's initial ("Y" for your own bills). It gives the eye a left-edge anchor (F-pattern) and makes bills without titles distinguishable.
- **Line 1:** the title ("Priya's bill") in body/600, and the **amount** right-aligned in tabular figures in ink. The amount is the largest text in the row.
- **Line 2:** the **status in words, starting with the verb**, plus the amount label right-aligned ("Your share" / "To collect" / "Total") in caption/muted.
  - Status text is teal (the One Voice accent) only when it's the viewer's next step: "Claim your items", "Pay Priya", "Fix who paid".
  - Otherwise it's muted: "2 people left to pay", "Priya sent you $12.40", "Claimed · not ready to pay".
  - This replaces the pill chrome. The words stay the same; only the capsule goes, which removes 20 coloured shapes from a busy screen.
- **Line 3:** the caption "Nov 24 · 5 people" (muted).
- **Trailing:** a chevron. The whole row is the tap target. There are no buttons in rows (one primary action per screen; the bill screen owns "Pay with Venmo").
- **Screen reader:** keep `homeRowA11yLabel`, which already says the title, date, people, amount phrase and status.

### Empty state (no bills at all)
```
            [receipt icon]
        No bills yet
  Scan a receipt to split it, or open a link
  a friend sent you to join theirs.

        [ Scan a receipt ]        ← primary button (the one place Home repeats +)
```
NN/g asks empty states for status, a learning cue and a direct path [P21]. Spliit names both routes in [S8]. Keep the sentence to 360 px (`layout.message`).

**"All caught up" state** (bills exist, nothing open): show the settled tile ("You're all settled up ✓") and the Settled row only. Don't show empty section headings.

### How it works with the bottom tab bar
- **(+) is the screen's primary action.** Remove any "Add receipt" button from Home's body, except in the empty state.
- **Home is about bills that need money to move.** History and events ("Priya sent you $12.40" over time) belong in **Activity**, so Home doesn't need a feed.
- **People and recurring circles belong in Groups.** That's where people-centric balances (pattern e) could live later.
- **Badge.** Use the tab badge on "Bills" only for "Needs you" items (critical, per the HIG), not for every change.
- **Spacing.** Leave bottom padding equal to the tab bar height plus the safe area, so the last row and "See all" are never under the bar on mobile web.

### Why this, tied to PRODUCT.md and the user's taste
- **"Calm over clever" / "clean and pretty, not over the top":**
  - The screen drops from four toggle headings and pill capsules to one summary, at most two short lists and a quiet footer row.
  - The surfaces stay flat, with hairline dividers between rows (DESIGN.md), no cards per bill and no colour fills for owe/owed.
- **"One obvious next step":** (+) in the bar for new bills, and each "Needs you" row says its own next step in teal words.
- **"Fair to the cent" / "Honest about what we know":** the summary sums only known integer-cent amounts and says in words when a share isn't known yet. It never shows a total that later turns out wrong.
- **"Fast at the table":** a friend who just joined sees "Claim your items" at the top of an open list with no taps, compared with today's tap-to-expand.
- **Accessibility:** status in words plus icon (WCAG 1.4.1, Said-Not-Shaded Rule), tabular money (Receipt Column Rule), full-width 56 pt rows (Fitts, Hoober).
- **Evidence:**
  - Balance-first matches Splitwise, Spliit and Cash App.
  - The always-open action list follows NN/g's accordion guidance and Apple's disclosure guidance.
  - The single Settled row matches the archive patterns in Tricount, Settle Up and Splitwise.
  - Two disclosure levels at most follows NN/g's progressive disclosure.

### Code impact (for whoever builds it; no code was changed)
- `HOME_SECTIONS_START_CLOSED` becomes `[]`. `claim` and `pay` render as one "Needs you" section (claim rows first), and `waitingFor` still decides each row's order.
- New pure helper in `lib/homeSections.ts`: `homeSummary(rows)` → `{ owesCents, owesBills, owedCents, owedBills, unknownBills }`, with unit tests on the boundaries ($0, unknown plan, routes plans).
- `MarkerView.pill` text becomes the status line. The pill component is retired on Home, and `tone: 'accent'` maps to teal text.
- An "Owed to you" cap with "See all", and a "Settled" row that pushes a list screen.
- Log the copy and the cap of 5 in `docs/decisions-to-review.md` (provisional values).

---

## Sources

**Competitors (C), Splitwise (S), Venmo/Cash App (V)**
- [S1] Pratt IxD, "Design Critique: Splitwise (iPhone App)", 2017. https://ixd.prattsi.org/2017/09/design-critique-splitwise-iphone-app/
- [S2] Splitwise blog, "Introducing Splitwise for Android version 5.0", 2021. https://blog.splitwise.com/2021/04/05/splitwise-for-android-v5-0/
- [S3] Splitwise blog, "Splitwise, redesigned", 2019. https://blog.splitwise.com/2019/07/09/splitwise-redesigned/
- [S8] Spliit source: README and English UI strings. https://github.com/spliit-app/spliit and https://raw.githubusercontent.com/spliit-app/spliit/main/messages/en-US.json
- [C1] Splitwise on the App Store (reviews). https://apps.apple.com/us/app/splitwise/id458023433
- [C2] Splitwise feedback forum / help (settled expenses hidden; dashboard balances). https://splitwise.uservoice.com/forums/162446-general/suggestions/11020530-1-after-you-settle-up-show-history-somewhere and https://splitwise.uservoice.com/knowledgebase/articles/746853-my-dashboard-balances-are-different-than-my-group
- [C3] IT Voice, "Splitwise has introduced restrictions on the number of free expenses users can add". https://www.itvoice.in/splitwise-has-introduced-restrictions-on-the-number-of-free-expenses-users-can-add ; Trustpilot reviews: https://au.trustpilot.com/review/splitwise.com
- [C4] Tricount help, FAQs (archiving, sorting, balances). https://help.tricount.com/articles/tricount-faqs
- [C5] Kimola, Tricount Google Play feedback report (third-party). https://kimola.com/reports/in-depth-tricount-app-feedback-report-reveals-crucial-insights-google-play-en-157042 ; Tricount "What happened with premium": https://tricount.com/en/what-happened-with-premium
- [C6] Settle Up tips. https://settleup.io/tips
- [C7] Splid on the App Store. https://apps.apple.com/gb/app/splid-split-group-bills/id991473495
- [C9] Tab – The simple bill splitter, App Store. https://apps.apple.com/us/app/id595068606
- [C10] UX Planet, "Splitwiser" redesign case study (student). https://uxplanet.org/splitwiser-the-all-new-splitwise-mobile-app-redesign-ui-ux-case-study-4d3c0313ae6f
- [C11] Digital Trends, Splitwise Itemize, Oct 14 2026. https://digitaltrends.com/phones/splitwise-now-lets-you-calculate-everyones-share-of-a-restaurant-bill-including-tax-and-tip/
- [C12] Tricount on the App Store. https://apps.apple.com/us/app/tricount/id349866256
- [C13] Settle Up on the App Store. https://apps.apple.com/us/app/id737534985
- [C14] AlternativeTo, Splitwise alternatives; Spliit friends-view PR. https://alternativeto.net/software/splitwise/ and https://github.com/debugx-x/spliit/pull/5
- [C15] splitty on the App Store. https://apps.apple.com/us/app/id1499263885
- [C16] Plates by Splitwise, App Store. https://apps.apple.com/us/app/id669801762
- [V1] PayPal newsroom, Venmo redesign, Jul 20 2021. https://newsroom.paypal-corp.com/07-20-2021-The-Venmo-App-You-Know-and-Love-Now-Has-a-New-Look-and-Feel
- [V2] PayPal newsroom, "Venmo Reimagines Its App Experience", May 11 2026. https://newsroom.paypal-corp.com/2026-05-11-Venmo-Reimagines-Its-App-Experience
- [V3] Venmo help, splitting/pending requests. https://help.venmo.com/hc/en-us/articles/217532327 and https://help.venmo.com/hc/en-us/articles/217532047
- [V4] TechCrunch, "Venmo's biggest makeover in years…", May 11 2026. https://techcrunch.com/2026/05/11/venmos-biggest-makeover-in-years-comes-at-a-very-interesting-time/ ; Money.com: https://money.com/venmo-app-redesign-privacy-changes/
- [V5] Cash App press, Money tab. https://cash.app/press/cash-app-green-banking-benefits-millions

**Principles (P)**
- [P1] NN/g, "Accordions on Desktop". https://www.nngroup.com/articles/accordions-on-desktop/
- [P2] NN/g, "Accordions Are Not Always the Answer for Complex Content". https://www.nngroup.com/articles/accordions-complex-content/
- [P3] NN/g, "Tabs, Used Right". https://www.nngroup.com/articles/tabs-used-right/
- [P4] NN/g, "F-Shaped Pattern of Reading on the Web". https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/
- [P5] Apple HIG, Disclosure controls. https://developer.apple.com/design/human-interface-guidelines/disclosure-controls
- [P6] NN/g, "Progressive Disclosure". https://www.nngroup.com/articles/progressive-disclosure/
- [P7] Laws of UX, Hick's Law. https://lawsofux.com/hicks-law/
- [P8] NN/g, "Inverted Pyramid". https://www.nngroup.com/articles/inverted-pyramid/
- [P9] NN/g, "Scrolling and Attention". https://www.nngroup.com/articles/scrolling-and-attention/
- [P10] Apple HIG, Segmented controls. https://developer.apple.com/design/human-interface-guidelines/segmented-controls
- [P11] Apple HIG, Tab bars. https://developer.apple.com/design/human-interface-guidelines/tab-bars
- [P12] Apple HIG, Lists and tables. https://developer.apple.com/design/human-interface-guidelines/lists-and-tables
- [P13] Android Developers, Material 3 `ListItem`. https://developer.android.com/reference/kotlin/androidx/compose/material3/ListItem.composable
- [P14] Laws of UX, Fitts's Law. https://lawsofux.com/fittss-law/
- [P15] Steven Hoober, "How Do Users Really Hold Mobile Devices?", UXmatters 2013. https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php
- [P16] Steven Hoober, "Design for Fingers, Touch, and People, Part 1", UXmatters 2017. https://www.uxmatters.com/mt/archives/2017/03/design-for-fingers-touch-and-people-part-1.php
- [P17] MDN, `font-variant-numeric`. https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric
- [P18] W3C, Understanding SC 1.4.1 Use of Color. https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- [P19] Apple HIG, Color (Inclusive color). https://developer.apple.com/design/human-interface-guidelines/color
- [P20] Colour Blind Awareness. https://www.colourblindawareness.org/colour-blindness/
- [P21] NN/g, "Designing Empty States in Complex Applications". https://www.nngroup.com/articles/empty-state-interface-design/
