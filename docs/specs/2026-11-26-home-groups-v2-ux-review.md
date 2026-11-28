# Home groups v2: UI/UX review (before build)

Date: 2026-11-26. Reviews `docs/specs/2026-11-26-home-groups-v2.md` (D5–D7, GV-1 to GV-20) against the current Home (`app/(app)/index.tsx`, `lib/homeSections.ts`, `components/ui/`), DESIGN.md, PRODUCT.md and design-system.md §10.
**No code or spec was changed.** The main session applies the amendments it accepts.

Method: design review only (detector not applicable, native/adaptive platform; reviewed from source and spec, nothing rendered). Questions skipped: delegated run. Open decisions for the user are listed at the end.

## Verdict in one paragraph

The structure is right: grouping by money ("Waiting on you", then "Owed to you", with "Settled" folded at the bottom) fits the user's goal, and nothing on it shouts. Three things undercut it, and all three are fixable before code. (1) **The Settled toggle doesn't look tappable, and its closed chevron says "opens a screen"**: on Home, `ChevronRight` already means "opens this bill". (2) **A payer row under "Owed to you" shows the bill total**, so "Owed to you … $86.40" reads as "I'm owed $86.40". That's a misread of money, which PRODUCT.md principle 4 forbids. (3) **The first load reshuffles more than v1 did**: paid-up bills appear and then vanish, and settled bills fill Owed and then fold away. Animating that would make it worse. Keep it still, and don't show the wrong frame in the first place. The rest is small rhythm and copy work.

## Scorecard (spec + current code, estimated)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | First-load moves; opening Settled can show nothing above the sticky bar on a small phone |
| 2 | Match with the real world | 2 | "Owed to you" next to a bill **total**; "Claimed · waiting on others" under "Waiting on you" |
| 3 | User control and freedom | 3 | Hidden bills have no way back (Q1, the user's call) |
| 4 | Consistency and standards | 2 | `ChevronRight` on a disclosure; a muted, heading-like toggle where every other tappable text is teal; a second toggle coming with Groups |
| 5 | Error prevention | 2 | A row can move or vanish under the thumb (or under VoiceOver focus) |
| 6 | Recognition over recall | 3 | Groups are named in plain words; the count is on the toggle |
| 7 | Flexibility and efficiency | 3 | Fine for a hub |
| 8 | Aesthetic and minimalist design | 3 | "Settled up" pill repeated on every Settled row; "You owe $X" next to "$X Your share" |
| 9 | Error recovery | 2 | A failed refresh silently reshuffles every group (GV-5 fallback) |
| 10 | Help and documentation | n/a | A hub screen; no help expected |
| | **Total** | **22/36** | Solid structure, fixable details |

Cognitive load: 1 failure out of 8 (chunking holds; a "Waiting on you" row carries title, caption, pill, amount, label and chevron, which is the most a row should carry). Personas: **Casey** (one-handed, dim light) taps a row that moves on first load, and opens Settled behind the bar. **Sam** (VoiceOver) loses focus when a focused guest row is hidden, and can't reach Settled with the heading rotor (accepted, GV-12). **Priya** (host/payer) has to subtract shares in her head to know what she's still owed.

## 1. Hierarchy across the states

Top to bottom: wordmark, then [notice / Venmo prompt], then [all-caught-up card], then **Waiting on you**, **Owed to you**, [Groups slot], **Settled (n)**, then the sticky bar.

- The order is right (GV-14): your move first, money coming to you second, done last. Section labels in `type.section` / `textMuted` are quiet, so the **rows and their figures** are the focal points, and the bar's one teal button is the only loud thing. Good.
- The all-caught-up card replaces the list as the focal point when it shows. Today the spec makes **both** lines muted (`type.body` and `type.caption`, both `textMuted`), so a card with two muted greys has no top line to read first. See S4.
- "Settled (n)" styled exactly like a section heading (D7) blends into the grid of labels. That's calm, but too calm: it's the only interactive label on the screen and it looks like the others. See M1.

## 2. Three groups plus the sticky bar on a 375 pt phone

Measured from current code: a row with a pill is about 94 pt tall (12 + 22 title + 4 + 18 caption + 4 + 22 pill + 12), a row without one about 68 pt. The bar is about 146 pt plus the bottom inset (HR-1 note).

- **iPhone SE (375 × 667):** the scroll area is about 521 pt. Top inset, header and gaps take about 104 pt. Two Waiting rows plus one Owed row put the Settled toggle at y ≈ 486–530, **right at the bar's top edge**. Opening it draws the card entirely under the bar. The tap looks dead. See S2.
- **iPhone 13 mini (375 × 812):** about 632 pt visible. Three groups of 1 to 2 rows fit, with the toggle visible.
- Calm? Yes, as long as each group stays short, which it does in practice: a group is open money, and most people have one to three open bills. The three labels are quiet, and cards are the only boxes. What makes it feel busy is **repetition inside rows** (S3, C3), not the number of groups.
- The bar's 146 pt is about 22% of an SE screen. Out of scope here (D1 stays), but it's the biggest lever on small-phone calm. See C5.

## 3. The Settled disclosure

| Aspect | Spec (D7) | Finding |
|---|---|---|
| Chevron | `ChevronRight` closed, `ChevronDown` open, 16 pt, muted | **Conflict.** Every Home row ends in `ChevronRight`, which means "opens a screen". A right chevron on the toggle promises navigation to a "Settled" screen. |
| Words vs chevron | Chevron only | A 16 pt muted chevron is the only clue that a muted 13 pt label is tappable. In dim light that's weak, and U1 step 7 already doubts it. The app's own disclosure (`SharesSummary`: "Everyone" / "Hide" plus a chevron, in teal caption 600) and `TextLink` show tappable text in teal. Words also show the new state at the finger even when the opened card is off-screen. |
| Colour | No teal ("not the next step") | DESIGN.md's One Voice Rule gives teal to the next step **and to links and ghost buttons**. A small teal "Show" is a link, not decoration. Keep the label itself muted so it still reads as a heading. |
| Count | `Settled (5)` | Good, and it matches the Groups spec's "Show hidden groups (1)". Keep the parentheses. |
| Target | `minHeight: 44`, full width | Good, but a 44 pt box around an 18 pt label pushes the label about 13 pt off the heading grid (37 pt above it instead of 24, and 21 pt to the card instead of 8). See S1. |
| Motion | Not specified | Settled is the **last** block, so opening only adds content below it and nothing on screen moves. There's no spatial problem to solve with motion, so it opens and closes instantly. Pressed opacity (`opacity.pressed`) is the feedback. A fade is optional (C1). Specify it either way, so nobody adds a height animation. |
| Reduce Motion | Not mentioned | With no animation there's nothing to reduce. If C1 is taken, use `reduceMotion: ReduceMotion.System`. If S2's auto-scroll is taken, it's `animated: !reduceMotion`. |
| Screen reader | button, `expanded`, label `Settled, 5 bills`, hints | Good. The rotor can't find it because it isn't a header (accepted, GV-12). Reading order (right after the last card) is fine. |

## 4. "You owe $14.80" next to "$14.80 Your share" (HR-4)

This happens only on `ready` guest rows. On `early` rows the figure is the **Total** (HR-3) and the pill is the only place the share shows, so the pill's amount can't be dropped across the board, and a conditional pill wording is more rule than it's worth. Under v2 the heading "Waiting on you" already says whose move it is, so the row says the same number twice in one glance. That's tolerable: same number, two jobs (status in words, figure in the receipt column). **Keep HR-4 for this slice** (C3), and revisit only if U1 calls it noisy. The repetition that *should* go is the "Settled up" pill on every Settled row (S3).

## 5. Rows moving between groups after the plan loads (GV-5, HR-11)

**Don't animate it.** It happens on every cold open of Home, which is tens of times a day (no animation: emil-design-eng, frequency rule). It's the system correcting itself, not the person's action, so motion would put a spotlight on a glitch. React Native can't animate a row from one `Card` into another (it unmounts in one parent and mounts in another), so any "move" would be a fake fade. And animation lengthens the window in which a row is moving under the thumb (Risk 1). A layout animation is the wrong fix.

The real fix is not to show the wrong frame. v2 makes the first-load jump much bigger than v1's "Recent → Waiting" move. A payer with five settled bills sees Owed to you grow by five rows and then fold away, and a guest sees paid-up bills listed as "Waiting on you" (with "Total") and then vanish. If VoiceOver focus is on one of those rows, focus is lost. See M3 (first load) and S5 (failed refresh).

## 6. Empty and caught-up states

- "You're all caught up." is right: short, warm, true. "Bills you've paid don't show here." is clear and honest. Keep both strings.
- It should stay a Card (consistent with "No bills yet." and the error card), left-aligned, with no heading. See S4 for type and grouping.
- With Groups (GR-20: group rows show no balances), "all caught up" could sit above a group where you owe $174. That's 52's call, but the wording should be chosen then (C4).
- The empty state's "action" is the bar's "Scan receipt", which is always visible. No extra button in the card (DESIGN: one filled button).

## 7. The amount on "Owed to you" rows

Today `rowAmount` returns the **bill total** for the host and the payer. Under a heading that says "Owed to you", `$86.40` reads as the amount owed. The "Total" label under it is 13 pt muted and loses that fight at a glance. It also leaves the payer doing the maths, and "the host stops doing maths" is PRODUCT.md's success line. The figure should answer the group's question: **how much is still coming to me**. That's M2. The pill already says **who** ("2 people left to pay", "Sam sent you $15.10"), so the figure and the pill read together as one sentence: *2 people left to pay · $31.20 to collect*.

## 8. Screen-reader order and labels

Order: "SplitIt" (header), Profile, notice, Venmo prompt, all-caught-up text, "Waiting on you" (header), rows (links), "Owed to you" (header), rows, Settled toggle (button, expanded state), settled rows, "Split a bill" (header), "Scan receipt", "Type items instead". This matches the visual order.

- The all-caught-up card should be read as one element (S4).
- With M2, the row label changes its amount phrase to `to collect $31.20` (`homeRowA11yLabel`). It still says everything the row shows, in order.
- The visible "Show"/"Hide" words and the chevron (M1) are hidden from screen readers. `accessibilityState.expanded` already says it, and the label and hints stay as in D5.
- With S3, the visible "Settled up" pill is hidden on Settled rows, but the row's a11y label **keeps** "Settled up, everyone has paid you". A screen-reader user doesn't get the "Settled" heading as context (it's a button, not a header), so the label should still say it.

## 9. Dark mode

Every pair uses existing tokens. Contrast (WCAG, computed):

| Pair | Light | Dark | Needs |
|---|---|---|---|
| `primary` text ("Show"/"Hide", caption 600) on `background` (the toggle sits on the table grey, not a card) | 4.97 | 10.32 | 4.5 ✓ |
| `textMuted` ("Settled (5)", headings) on `background` | 6.87 | 8.87 | 4.5 ✓ |
| `text` (caught-up line, S4) on `surface` | 17.74 | 15.72 | 4.5 ✓ |
| `textMuted` (hidden note, "To collect") on `surface` | 7.56 | 7.98 | 4.5 ✓ |

`primary` on `background` in light mode (4.97) is the tightest pair. It passes for 13 pt only because the weight is 600. Don't drop the toggle words to weight 400. In dark mode `surface` (#161B22) is only 1.11:1 against `background`, so cards separate by their hairline (`divider`, 1.48:1). That's fine for decoration, and nothing relies on it.

## Spec amendments

### Must

**M1. The Settled toggle: never `ChevronRight`; add "Show"/"Hide" words.** Replaces D7's "Look" bullet and GV-12's look.
- Layout: one `Pressable` row, full column width, `flexDirection: 'row'`, `alignItems: 'center'`, `gap: space.sm`, `minHeight: TOUCH_TARGET`, `paddingHorizontal: space.xs` (SectionHeader's inset on both ends).
- Left: `settledToggleText(count)` → `Settled (5)` in `type.section`, `colors.textMuted`, `flex: 1, minWidth: 0` (wraps at large text sizes).
- Right, in a `View` with `accessible={false}` and `importantForAccessibility="no-hide-descendants"`, `flexDirection: 'row'`, `gap: space.xs`: the text `HOME_COPY.settledShow` = `'Show'` (closed) or `HOME_COPY.settledHide` = `'Hide'` (open) in `type.caption` + `fontWeight: '600'`, `colors.primary`; then `Icon` `ChevronDown` (closed) or `ChevronUp` (open), `size="sm"` (16), `colors.primary`. This is the SharesSummary toggle's look, so the app has one disclosure language.
- Pressed: `opacity.pressed`. Focus: `useFocusRing` with `radius.sm` and `borderCurve: 'continuous'`.
- Unchanged: role `button`, label `settledToggleA11y(n)`, `expanded`, both hints.
- Criteria: 29 gains "renders no `ChevronRight`; its visible word is `Show` when closed and `Hide` when open, and that word isn't announced". 23 gains the two new copy constants.

**M2. Payers see what's still owed to them, not the bill total.** Amends D3 (home-mobile-refresh), D5 and D9 here.
- `RowAmountKind` gains `'collect'`. `amountLabel('collect')` = `'To collect'`. `homeRowA11yLabel` amount phrase: `` `to collect ${figure}` ``.
- Rule, in `lib/homeSections.ts`, using `viewerIsPayer` (the only payer check, criterion 9): viewer is the payer **and** `plan.status === 'ready'` **and** the row's group is `owed` → `cents = Σ over other entries o of (o.mark === null && o.role === 'owes' ? o.owedCents : 0) + (differenceOf(o)?.kind === 'more' ? differenceOf(o).cents : 0)`. Otherwise keep today's rule (Total, or the guest's share).
- It's one integer sum in `lib/`, with no rounding and the same 1¢ tolerance through `differenceOf`. D9's "no money arithmetic" becomes "no money arithmetic outside `lib/homeSections.ts`; one sum, tested". Tests: P1 (800), P4 (2), P6 (2: the `more` counts, the `back` doesn't), P7 (500), the `sent` fixture (the unmarked share only), P2/P8 → Settled rows keep Total. The row label is checked for `to collect $X.XX`.
- Early, blocked and no-plan payer rows keep **Total**: the shares can still move (same reasoning as HR-3).
- If the main session won't add the sum in this slice, the minimum is to log it as a known misread in `docs/before-production.md` and U1 step 5. Don't ship it silently.

**M3. Don't show the wrong frame on first load (needs the user's yes: reverses SE-UX-14 / HR-11 for the first load only).** Replaces GV-5's first-load behaviour; Risk 1 becomes a non-issue.
- On Home's **first** load only (bills going from `loading` to `ready`), keep showing the existing loading state ("Your bills" + spinner card) until the first settle read **resolves or fails, or 1000 ms pass**, whichever comes first. Then render the groups. After a timeout or a failure, use GV-5's fallback as specified.
- Refreshes (focus, foreground) don't wait. `keepCandidates` already keeps the previous facts, so nothing moves.
- No layout animation for group changes, ever. Add to D6: "Rows change group without motion."
- Criterion 33's "pending" test becomes: the spinner shows while the first settle read is pending, then the final groups appear with W absent and S under a collapsed Settled. Add a test with fake timers: at 1000 ms the fallback groups render.

### Should

**S1. Keep the toggle on the heading grid.** On the toggle add `marginVertical: -(TOUCH_TARGET - type.section.lineHeight) / 2` (−13). The label then sits 24 pt below the previous card, like every other heading, and 8 pt above its own card when open (the section's `gap: space.sm`). The 44 pt target is kept: the extra height overlaps the gaps, and the open card, drawn later, wins the 5 pt overlap. Put the toggle and the open card in one `View` with `gap: space.sm`, keyed `settled`.

**S2. Make opening visible above the bar.** On open, if `toggleY + TOUCH_TARGET + space.sm + ROW_MIN_HEIGHT > scrollY + visibleHeight`, call `scrollRef.current?.scrollTo({ y: toggleY + TOUCH_TARGET + space.sm + ROW_MIN_HEIGHT + space.lg - visibleHeight, animated: !reduceMotion })`. That's the smallest scroll that shows the toggle and the first settled row. `toggleY` comes from `onLayout`. `reduceMotion` comes from `AccessibilityInfo.isReduceMotionEnabled()` (or Reanimated's `useReducedMotion`). Closing never scrolls. Behaviour change; test with a mocked `scrollTo`.

**S3. No "Settled up" pill on rows inside Settled.** The toggle already says it. Five identical muted capsules are noise. `BillRow` takes `showPill={row.group !== 'settled'}`; `row.pill` and `row.a11yLabel` stay unchanged (the label keeps "Settled up, everyone has paid you", §8). U1 step 4 becomes "X shows, without a pill". Criterion 28 adds: settled rows render no pill text but keep the label.

**S4. The all-caught-up card: one top line, one element.**
- `Card` (default, not muted), `gap: space.xs` (overriding Card's 12: two lines of one message are label-to-value spacing).
- `allClear` in `type.body`, **`colors.text`**: the screen's one top line in this state. `hiddenNote` in `type.caption`, `colors.textMuted`.
- The card's inner `View` gets `accessible` and `accessibilityLabel={hiddenCount > 0 ? \`${allClear} ${hiddenNote}\` : allClear}`, so it's one swipe. No role, no heading.

**S5. A failed refresh doesn't reshuffle Home.** Today HM-5 drops every plan on failure. Under v2 that moves every settled bill back to Owed to you and brings every hidden bill back to Waiting on you, with no message. On a failed **refresh**, keep the previous facts for this load's candidates (`keepCandidates(prev, candidates)`, as during pending). Drop them only when the **first** read fails (then M3 / GV-5's fallback). HM-5's "a missing pill is harmless" no longer holds when a missing plan moves rows. Engineering and user decision; amends GV-5 and before-production item 2.

**S6. One disclosure primitive for Settled and hidden groups.** The Groups MVP adds "Show hidden groups (N)" / "Hide" right above Settled (T13). Two toggles in two styles, stacked, is the "detail that differs from its siblings" bug. Build D7 as `components/ui/DisclosureRow.tsx` (`{ label; a11yLabel; open; onToggle; showHint; hideHint }`, M1's look) and have `SettledToggle` be a thin wrapper, or skip the wrapper. Tell splitit-app-52 to use it with `Hidden groups (1)` and the same Show/Hide words.

**S7. Fix the copy clash "waiting on others" under "Waiting on you" (D-1, the homeMarkers owner and the user).** The heading says *on you*, and the pill says *on others*. Proposal: pill `Claimed · not ready to pay` (a11y unchanged: "You've claimed. You can pay once the bill is ready"). It uses the user's own rule-1 wording ("claimed, but can't pay yet") without a negative "can't".

**S8. Say "no motion" in the spec.** D7: "The Settled card appears and disappears with no animation; the toggle's feedback is pressed opacity and the Show/Hide word." D6: "Rows never animate between groups." This keeps a later pass from adding `LayoutAnimation` (flaky on Android and react-native-web) or a height animation.

### Could

**C1. Optional 150 ms opacity fade-in for the opened Settled card** (Reanimated `entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}`, no exit animation, no height or translate). Only if U1 says the instant open feels abrupt. Opacity is allowed under Reduce Motion, but System skips it anyway, which is fine.

**C2. A guest under "Owed to you" (`paid_back_due`) shows the pay-back as the figure** (`differenceOf(me).cents`, label `Back to you`) instead of "Your share". It's M2's logic applied to guests. It's rare, and the pill already names the amount, so defer unless U1 trips on it.

**C3. Keep HR-4** (the pill amount next to the share) for this slice. Revisit after U1. Don't make the pill's wording depend on the plan state.

**C4. For splitit-app-52:** once group rows sit on Home without balances, scope the card to bills: `You're all caught up on bills.` Or show the card only when no group has a balance, which needs GR-20 reversed.

**C5. Bar height (out of scope, D1).** On an SE the bar takes about 22% of the screen. A later pass could keep the "Split a bill" heading for screen readers only and draw just the button and link (about 102 pt). It needs HR-1 and review R2 revisited.

**C6. A payer who only owes pay-backs** (Waiting on you, `differences` back) keeps Total. If M2 lands, the symmetric figure is `To pay back`. Defer: rare.

## Recommended Home (375 pt, after M1–M3, S1, S3, S4)

```
┌───────────────────────────────────────┐
│ SplitIt                          (◯)  │  display / Profile IconButton
│                                       │
│  Waiting on you                       │  section, textMuted
│ ┌───────────────────────────────────┐ │
│ │ Hana's bill              $14.80  › │ │  body / body 600 tabular
│ │ Nov 20 · 3 people     Your share   │ │  caption muted
│ │ ( You owe $14.80 )                 │ │  accent pill
│ ├───────────────────────────────────┤ │
│ │ Dee's bill               $62.10  › │ │
│ │ Nov 18 · 5 people          Total   │ │
│ │ ( Claimed · not ready to pay )     │ │  muted pill (S7)
│ └───────────────────────────────────┘ │
│                                       │  24
│  Owed to you                          │
│ ┌───────────────────────────────────┐ │
│ │ Your bill                $31.20  › │ │  M2: still owed, not the total
│ │ Nov 22 · 4 people     To collect   │ │
│ │ ( 2 people left to pay )           │ │
│ └───────────────────────────────────┘ │
│                                       │  24 (S1: on the heading grid)
│  Settled (5)                 Show ⌄   │  muted label · teal caption 600 + 16pt chevron
│                                       │
├───────────────────────────────────────┤  hairline, surface
│  Split a bill                         │
│ ┌───────────────────────────────────┐ │
│ │           Scan receipt            │ │  the one primary
│ └───────────────────────────────────┘ │
│           Type items instead          │
└───────────────────────────────────────┘

Settled open (no animation; S2 scrolls just enough to show the first row):
│  Settled (5)                 Hide ⌃   │
│ ┌───────────────────────────────────┐ │
│ │ Your bill                $86.40  › │ │  no "Settled up" pill (S3)
│ │ Nov 12 · 4 people          Total   │ │
│ ├───────────────────────────────────┤ │
│ │ …                                  │ │

All caught up (Waiting and Owed empty):
│ ┌───────────────────────────────────┐ │
│ │ You're all caught up.              │ │  body, text (S4)
│ │ Bills you've paid don't show here. │ │  caption, textMuted; one a11y element
│ └───────────────────────────────────┘ │
│                                       │
│  Settled (5)                 Show ⌄   │
```

## What I'd leave alone

- The group order (GV-14), the headings without counts (HR-18), the count only on Settled, Settled collapsed on every mount (GV-11), owed-before-owes for payers (GV-2), list order inside groups (HR-9), and the row anatomy (D2). All calm and correct.
- `Card flush` + `ListRow` for every group. Settled rows look exactly like the others (consistency over a "faded history" treatment).
- Two pill tones, no icons (SE-VIS-1, Q-GLYPH).

## Decisions for the user

1. **M3:** hold the first Home load up to 1 s for settle data, so paid-up bills never flash in "Waiting on you"? (Reverses SE-UX-14 / HR-11 for the first load only.)
2. **M2:** show payers `$31.20 To collect` instead of the bill total under "Owed to you"? (Adds one tested sum in `lib/`.)
3. **S7:** rename the pill "Claimed · waiting on others" to "Claimed · not ready to pay"?
4. **S5:** keep the previous groups when a refresh's settle read fails, instead of reshuffling?

## Test impact (for the main session)

Criteria 23 (new copy), 27 and 28 (pill hidden in Settled; toggle words), 29 (no `ChevronRight`, words not announced, minHeight still ≥ 44), 31 (card is one a11y element), 33 (rewritten if M3 is taken), 13 / 21 (M2's `collect` amount on payer fixtures), plus U1 steps 4 and 7. Criterion 38's grep (`differenceOf` absent from `app/(app)/index.tsx`) still holds: M2's sum lives in `lib/homeSections.ts`.
