# Sent via Venmo and payment methods: visual design

Date: 2026-11-26. Third document for this slice, after the spec (`docs/specs/2026-11-26-sent-via-venmo.md`, data, money, contracts) and the UX brief (`docs/specs/2026-11-26-sent-via-venmo-ux.md`, layout, states, copy). This one covers only how things look: tone, type, spacing, alignment, wrapping and motion. **No code was changed.** The user asked for it to feel "seamless, calm and positive, easy to see and follow, with little work for the person using it".

Rules kept: existing tokens from `lib/theme.ts` only (no new colours, sizes or spacing values); no glyphs in copy (VP-30), icons come from `tone` through `ToneIcon`; Home pills have two tones, accent or muted, and no icon (SE-VIS-1, Q-GLYPH); one primary per card; no modals, toasts, confetti or decorative motion. Decisions are logged as **SV-VIS-1 … SV-VIS-14** in `docs/decisions-to-review.md` ("Sent via Venmo, visual design"). §10 lists the model and primitive changes for the engineering design.

Built from: the spec and brief (§13 notes); the coordinator's note on Home groups v2 (Waiting on you / Owed to you / Settled / Hidden; that spec isn't on disk yet, so §5.2 and §6 follow the note); `lib/theme.ts`; `components/ui/{Button,SegmentedControl,TextLink,StatusLine,ToneIcon,Banner,Card}.tsx`; `components/{SettleCard,SettlePeopleList,SettleFooter}.tsx`; `app/(app)/index.tsx` (`BillRow`, `MarkerPill`); `lib/homeSections.ts` and the Home refresh spec (`docs/specs/2026-11-26-home-mobile-refresh.md`, D2/D4); the previous visual doc (`2026-11-25-settle-early-and-differences-visual.md`); the `ui-ux-designer` skill; the `[area: expo]` lessons; screenshots p1–p6 (Settle early, marked early, rows at 375 pt, Home pills in dark, the footer's "Did you pay?").

Worked example as in the brief: **Hana** paid the bill (`@hana-1`), **Sam** owes $15.10, **Dee** is a second ower.

## 0. Audit of today's look, for this slice

| Surface | Works today (screenshots) | Problem this slice would add |
|---|---|---|
| Owes card (p1-b-settle-early) | One clear focal point: label, 32-pt amount, muted lines, one block primary, notes, one ghost | A method chooser between the amount and the primary is a second teal shape right above the teal button. Stretched to full width with the solid teal thumb (VP-39), it reads as a second button and competes |
| Marked card (p1-b-settle-marked-early) | Green check line + muted explanation + `Undo`; calm | Nothing says "you're done". The absence of a button is the only signal |
| Card ghost row | Flush ghosts on the text edge | `Button flush` keeps `minWidth: 44` and centres its label, so a short label is indented: `Undo` (~36 pt) by 4 pt, `Yes` (~27 pt) would be by ~8 pt. Visible next to a left-aligned caption |
| Everyone rows (p4-a-settle-rows-375) | Status column, flush-right controls | Stacked 44-pt ghost controls already make tall rows (`Pay back`, `I paid it back`, `Undo`). A teal `Not received` on **every** marked row would be the loudest repeated thing on a list of good news |
| Footer (p6-b-footer-did-you-pay-early) | Question in `label`, primary `I paid`, ghost `Not yet`, `Details` right | The check-in question doesn't need a primary: the default answer (do nothing) is already "yes" |
| Home pills (p6-a-home-pills-dark) | Two tones read calmly in both schemes | Home groups v2 puts a fully paid payer bill in a collapsed Settled group, which would hide the last "sent" news (§6.1, P4). Long sender names (`Alexandra sent you $15.10`) will wrap into two-line capsules more often than today's pills |

Native-slop check for the plan below: no new cards or tinted blocks inside cards, no emoji or text glyphs, no shadows, no new colour, one motion (quiet, optional, off under Reduce Motion).

## 1. The method choice on the owes card (SV-VIS-1, SV-VIS-2)

### 1.1 The control
**The existing `SegmentedControl`, in its hugging mode (no `stretch`), left-aligned on the card's text edge, with today's selected look (solid `primary`, `onPrimary` text, 700).** No `checkSelected`: "Venmo" and "Cash" can't be misread, and the fill already differs by more than colour (fill + weight).

Why not the alternatives:
- **Full-width segmented** (the brief's suggestion): a ~153 × 40 solid teal thumb 12 pt above a 311 × 44 solid teal button. Two teal bars stacked read as two buttons, and "Venmo" looks like something you already tapped.
- **A tinted (quiet) selected segment**: `primarySurface` on the `surfaceMuted` track is **1.02:1 light / 1.05:1 dark**. The selection would be carried by text colour alone. That's why VP-6 was replaced by VP-39, and it would make this one control look different from every other segmented control in the app.
- **Chips**: same teal mass as segments, plus a new pattern.
- **"Pay with: Venmo ▾" link**: the calmest, but it hides the choice behind a tap and a sheet. Cash payers would do more work, and the user asked for "easy to see".

Hugging, the track is about 137 pt wide (Venmo ~73, Cash ~58, plus insets) and the teal thumb about 73 × 40: a small setting that sits under the amount, about a quarter of the button's area. It reads as "how", and the full-width button underneath reads as "do it". Segment widths follow their labels, as in the `% / $` tip switch. A 15-pt difference between the two segments is within what iOS itself draws with content-sized segments.

### 1.2 Placement and rhythm
The chooser opens the action group, so it groups with the button it changes, not with the amount:

```
┌──────────────────────────────────────┐
│ You owe Hana                         │  label 15/600 text
│ $15.10                               │  display 32/700, tabular
│ Your share may change until …        │  (early only) caption muted
│                                      │  16  (card gap 12 + action marginTop 4)
│ ┌───────────┬────────┐               │
│ │▓▓ Venmo ▓▓│  Cash  │               │  SegmentedControl, hug, 44 tall
│ └───────────┴────────┘               │
│                                      │  12  (action gap 8 + chooser marginBottom 4)
│ [▓▓▓▓▓▓ Pay Hana $15.10 on Venmo ▓▓▓]│  primary, block
│ @hana-1 · $15.10                     │   8  note, caption muted
│ We'll check back in a minute to make │   8  note (native, permission undetermined)
│ sure it went through.                │
│                                      │  12  card gap
│ Paid another way                     │  ghost, flush start
└──────────────────────────────────────┘
```

| Gap | Value | Why |
|---|---|---|
| Head group → chooser | 16 (`space.md` card gap + `space.xs` action `marginTop`, today's values) | Same air the button gets today |
| Chooser → primary | 12 (`space.sm` action gap + `space.xs` `marginBottom` on the chooser) | Closer than the head, further than the notes: chooser and button are one decision |
| Primary → notes | 8 (`space.sm`, today) | Unchanged |
| Notes → ghost row | 12 (card gap, today) | Unchanged |

**Switching** swaps only the primary's label and the notes under it. The chooser, the label and the amount don't move. With Cash selected the notes disappear, so the ghost row moves up by the notes' height (about 26–52 pt). No animation for this: it's a direct response to the tap, and the button the person is looking at stays in place.

**Cash selected:**
```
│ You owe Hana                         │
│ $15.10                               │
│ ┌─────────┬────────┐                 │
│ │  Venmo  │▓ Cash ▓│                 │
│ └─────────┴────────┘                 │
│ [▓▓▓ I paid Hana $15.10 in cash ▓▓▓▓]│  primary; nothing opens
│ Paid another way                     │  ghost
```

**Cash only** (Hana has no Venmo, SV-29): no chooser. `Hana hasn't added Venmo yet.` is a muted head line, then the cash primary. Same rhythm as today's no-Venmo card.

**More-due card:** the same chooser in the same slot, under the B1 head (`You owe Hana more` / `$1.10` / muted `Your share is now $16.20. You've sent $15.10.`).

### 1.3 States, targets and contrast

| State | Look |
|---|---|
| Selected | `primary` fill, `onPrimary` text, 700 |
| Unselected | no fill (the `surfaceMuted` track shows), `text`, 600 |
| Pressed | `opacity.pressed` (0.7), as every pressable |
| Disabled (any write from the card in flight) | whole control at `opacity.disabled` (0.5), not pressable, `accessibilityState.disabled` (needs a new `disabled` prop, §10) |
| Keyboard focus (web) | the existing 2-pt `focus` ring, 2 pt off the segment |

Touch target: each segment is 40 tall inside a 44 track and has `hitSlop` 2 top and bottom (existing), so 44 tall. The narrowest segment ("Cash") is ~58 wide, above the 44 minimum.

| Pair | Light | Dark | Need |
|---|---|---|---|
| `onPrimary` on `primary` (selected label) | 5.47 | 9.18 | 4.5 |
| `text` on `surfaceMuted` (unselected label) | 15.95 | 13.86 | 4.5 |
| `primary` thumb vs `surfaceMuted` track (selected indicator) | 4.92 | 8.20 | 3 |
| `primary` thumb vs `surface` card | 5.47 | 9.29 | 3 |
| `surfaceMuted` track vs `surface` (shape only, not relied on) | 1.11 | 1.13 | n/a |

Large text: the labels grow, and the track grows with them (hug mode). At the largest accessibility size, "Venmo" is about 105 pt and the track about 240 pt, which still fits the 311-pt inner width at 375 pt. Nothing clips.

## 2. The positive confirmation moments (SV-VIS-3, SV-VIS-4, SV-VIS-7)

The rule: **"done" looks like less, not more.** The primary disappears, a green check line states the fact, and one warm muted sentence closes the card. The good feeling comes from the button being gone and the sentence, not from colour blocks or motion.

### 2.1 Sam, right after Pay: "Sent to Hana · $15.10"
On the card, label and amount say it ("You sent Hana" / "$15.10"), and the success line confirms it. The footer caption carries the literal `Sent to Hana · $15.10` (§7). No toast: on a phone Sam is in Venmo when the card changes.

```
Before (owes)                              After (sent, question still open)
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│ You owe Hana                     │       │ You sent Hana                    │  label: the only word that changes
│ $15.10                           │       │ $15.10                           │  amount stays in the same place
│ [Venmo|Cash]                     │       │ ✔ Sent via Venmo                 │  success 13/600, ToneIcon Check
│ [   Pay Hana $15.10 on Venmo   ] │       │                                  │  12
│ @hana-1 · $15.10                 │       │ Did it go through?               │  caption muted
│ Paid another way                 │  ──▶  │ Yes      No, undo                │  ghost, ghost (§3)
└──────────────────────────────────┘       └──────────────────────────────────┘
```
(`✔` in these sketches is the `ToneIcon` drawn from `tone: 'success'`, never a character in the string.)

### 2.2 Sam, when the question is answered or gone: "You're all set. Hana can see it."
```
┌──────────────────────────────────┐
│ You sent Hana                    │  label 15/600 text
│ $15.10                           │  display 32/700
│ ✔ Sent via Venmo                 │  success 13/600, check icon
│ You're all set. Hana can see it. │  caption 13/400 textMuted, same head group (4 pt)
│                                  │  12
│ Didn't go through? Undo          │  ghost, flush start
└──────────────────────────────────┘
```
- The completion line is a **muted head line**, 4 pt under the success line, so the fact and its reassurance read as one thought. It isn't green: one green line per card, and the check icon has already said "good".
- Cash: `You paid Hana` / `$15.10` / `✔ Paid in cash` / the same completion line / `Undo`. "Paid another way": `✔ Marked paid` / completion line / `Undo`.
- Early marked cards keep the settle-early muted line in the same slot instead (brief §4.3). Same look.

### 2.3 Hana, everyone done: "Everyone's settled up. Nice."
```
Before                                    After
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│ 3 people owe you                 │      │ Everyone's settled up. Nice.     │  label 15/600 text
│ $45.20                           │ ──▶  │ $45.20                           │  display 32/700
│ 1 of 3 settled up                │      │ ✔ 2 sent via Venmo · 1 paid in   │  success 13/600
└──────────────────────────────────┘      │   cash                           │  (wraps under its first word,
                                          └──────────────────────────────────┘   not under the icon)
```
- Only the label changes words, so the moment is noticed without anything moving. The amount stays as the anchor: it's what was collected.
- The method line is the card's one success line. While people are still open, `1 of 3 settled up` stays muted (a status, not good news yet).
- The `Everyone` card's aside becomes `All settled up`, muted caption as today.

### 2.4 Motion (SV-VIS-7)
**None on arrival.** The sent card is already in place when Sam comes back from Venmo, and an entrance animation would replay on every visit. No haptics (brief §9).

**One quiet transition, native only:** when the inline question is answered (Yes → completion line; No, undo → back to the owes card), the card's height changes by about 44 pt and the Everyone card below jumps. Wrap the Settle screen's card stack in a Reanimated layout transition: `LinearTransition.duration(200)` with ease-out, `.reduceMotion(ReduceMotion.System)` so it's instant when Reduce Motion is on. The swapped line itself appears instantly (no fade): the text is the feedback, and the motion only keeps the card below from snapping. Web: instant (no layout animation), which is today's behaviour. If the implementer finds layout transitions unreliable on the installed Reanimated 4.5.1 with this tree, drop it. Nothing depends on it.

## 3. The inline "Did it go through?" line (SV-VIS-5, SV-VIS-6)

**Quiet, easy to find:** a muted caption, then two teal ghost buttons on the text edge. It's the only interactive thing on the card while it shows (the card's Undo is hidden), so two teal words under a green line are easy to spot without a box.

```
│ ✔ Sent via Venmo                 │  head group ends
│                                  │  12  card gap
│ Did it go through?               │  caption 13/400 textMuted
│ Yes      No, undo                │  ghost 15/600 primary, flush start, gap 16
└──────────────────────────────────┘
```

| Property | Value |
|---|---|
| Slot | its own block after the head group (card gap 12 above), where the ghost row would be. Not part of the head group: it's a question, not a status |
| Question | `type.caption`, `textMuted`, regular. Not live (SV-UX-21) |
| Answers | `Button variant="ghost" flush`, in a wrapping row, `gap: space.lg` (16), the same as the card's ghost row. Question → answers: no extra gap; the 44-pt buttons' own padding leaves ~13 pt above the words |
| Alignment | `Yes` must sit on the text edge. Today a short flush label is centred in its 44-pt box (`Yes` would be ~8 pt in). New `Button` option: flush content aligned to the start (§10, SV-VIS-6). The box stays 44 × 44 |
| Targets | `Yes` 44 × 44 (label ~27 pt wide, box widened by `minWidth`), `No, undo` ~64 × 44; 16 apart, so the two boxes never touch |
| Busy | `No, undo` shows the button's spinner; `Yes` is disabled (0.5) |
| Results | Yes: the block is replaced by the completion line (§2.2) and the `Didn't go through? Undo` ghost. No, undo: the owes card (§1) with the same chooser selection |
| More-send confirm | the existing inline warning `Banner` in the same slot: `BannerText` + `[Undo all]` (danger, tonal) + `Keep it` (ghost), `gap: space.sm`, like the row Undo confirm |
| Errors | the card's existing error `Banner` at the bottom, unchanged |

| Pair | Light | Dark |
|---|---|---|
| `textMuted` on `surface` (question) | 7.56 | 7.98 |
| `primary` on `surface` (answers) | 5.47 | 9.29 |
| `danger` on `dangerSurface` (Undo all) | 6.05 | 8.24 |
| `text` on `warningSurface` (confirm text) | 17.00 | 13.41 |
| `dangerSurface` vs `warningSurface` (tonal button shape inside the banner) | 1.04 | 1.08 |

The last pair is today's row-Undo confirm too. The danger button's shape barely shows on the warning banner, but its red label (6.30 / 7.60 on `warningSurface`) and its position make it readable. Left as is (existing pattern); noted for a later primitives pass.

## 4. The payer's rows (SV-VIS-8, SV-VIS-9)

### 4.1 Statuses
| Status | Tone | Icon (from tone) | Contrast on `surface` L / D |
|---|---|---|---|
| `Sent via Venmo` | success | Check | 5.69 / 10.69 |
| `Paid in cash` | success | Check | same |
| `Paid` (other) | success | Check | same |
| `Not yet` | muted | none | 7.56 / 7.98 |

All three method statuses are success. The words say how, and colour only says "settled". Three greens for three methods would be a rainbow.

**Column width:** `Sent via Venmo` with its icon is ~115 pt, `Paid in cash` ~98 pt. Today's `minWidth: 64` would let the money column drift between a `Not yet` row and a `Sent via Venmo` row. **Use the existing 120-pt wide status column (SE-VIS-6) whenever any row shows a method status** (in practice, any marked row). At 375 pt the name column then gets ~117 pt, as it does with differences. At large text `Sent via / Venmo` wraps inside the 120 column, right-aligned, and the column stays flush right (`marginLeft: 'auto'`, existing).

### 4.2 "Not received": easy to find, hard to hit by accident
**A `TextLink` (caption 13/600, `primary`), on its own line, flush right**, where the payer's Undo sits today. One step quieter than the ghost `Request` / `Pay back` buttons: it's a rare correction, not a next step, and on a list where everyone has paid it shouldn't be the loudest repeated thing. Teal and always in the same place, so it's easy to find when needed.

```
┌ Everyone ──────────────────────────────────┐
│ Sam              $15.10   ✔ Sent via Venmo │  main line (one a11y element, not tappable)
│                               Not received │  TextLink 13/600, flush right, 44 tall
│────────────────────────────────────────────│
│ Dee              $20.00     ✔ Paid in cash │
│                               Not received │
│────────────────────────────────────────────│
│ Kim              $12.00            Not yet │
│ @kim-1                             Request │  ghost 15/600 (unchanged)
└────────────────────────────────────────────┘
```

| Spacing | Value | Why |
|---|---|---|
| Main line → Not received | row gap 4 (`space.xs`, today) | The link's 44-pt box centres 18-pt text, so the words sit ~17 pt under the status: clearly its own line, still visibly part of the row |
| Another control above it (back-due rows: `Pay $1.10 back`, `I paid it back`) | `marginTop: space.sm` (8) on the link, so 12 between the two 44-pt boxes | Stacked controls today touch at 4 pt; the one that clears someone else's record gets extra room |
| Not received → next row | row `paddingVertical` 8 + hairline + 8, then the next row's **non-interactive** main line (~22) + 4 before its first control | ≥ 40 pt between this link and any other tap target below it |
| Horizontal | right edge on the status/money column edge; nothing else on its line | No neighbour to mis-tap sideways |

Target: 44 tall (TextLink's `minHeight`), ~80 pt wide (the label). Add `minWidth: TOUCH_TARGET` to `TextLink` anyway (§10) so any short link is 44 wide. The confirm (one more deliberate tap) is the real guard against accidents: the existing inline warning Banner, `Didn't get Sam's $15.10? This clears it and lets Sam know.`, `[Not received]` (danger, tonal) + `Cancel` (ghost).

While a row action is in flight: the link is disabled (0.5) on every row, and on the busy row it shows a small spinner in `primary` before the label (needs `disabled` / `loading` on `TextLink`, §10).

The host who isn't the payer keeps today's ghost `Undo` on these rows (SV-10), unchanged. **Left alone on purpose:** I didn't restyle that Undo to match. It's a different person's control with a different meaning, and the user hasn't asked for it.

**After Not received:**
```
│ Sam              $15.10            Not yet │  muted
│ Not received · $15.10                      │  sub-line, caption muted (existing slot)
│ @sam-1                             Request │  (ready plans)
```
The sub-line is muted, not warning: it's Hana's own action, already done, and nothing for her to fix.

| Pair | Light | Dark |
|---|---|---|
| `primary` on `surface` (Not received) | 5.47 | 9.29 |
| `success` on `surface` (statuses) | 5.69 | 10.69 |
| `textMuted` on `surface` (sub-line) | 7.56 | 7.98 |

## 5. "Not received" on Sam's side (SV-VIS-10)

### 5.1 The card's warning line
```
┌──────────────────────────────────────┐
│ You owe Hana                         │
│ $15.10                               │
│ ▲ Hana hasn't received your $15.10.  │  warning 13/600, ToneIcon TriangleAlert
│   Check Venmo before paying again.   │  (wraps under its first word)
│                                      │  16
│ ┌───────────┬────────┐               │
│ │▓▓ Venmo ▓▓│  Cash  │               │
│ └───────────┴────────┘               │
│ [▓▓▓▓ Pay Hana $15.10 on Venmo ▓▓▓▓▓]│
│ @hana-1 · $15.10                     │
│ Paid another way                     │
└──────────────────────────────────────┘
```
- The first head line under the amount, the card's **only** warning-tone line, 600 weight like every toned line. The label/amount slot never moves.
- No banner and no tinted block: the line is calm and says what to do. The `TriangleAlert` shape differs from error's `CircleAlert`, so it's not read as a failure.
- Contrast `warning` on `surface`: **7.52 light / 11.18 dark**.
- At 375 pt the Venmo copy takes 2 lines (~291 pt beside the icon), and 3–4 lines at large text. The icon stays on the first line (`alignItems: 'flex-start'`, existing).

### 5.2 Home pill: `Not received · $15.10`
**Amended 2026-11-26 for Home groups v2** (`docs/specs/2026-11-26-home-groups-v2.md`, in progress in splitit-app-96; there's no "Recent" section any more). The groups are **Waiting on you** (new, unclaimed, owes, paid_more, not_received, "claimed, can't pay yet"), **Owed to you** (the viewer is the payer and someone still owes), **Settled** (collapsed: payer and everyone paid) and **Hidden** (guest bills already paid in full).

Accent (`primary` on `primarySurface`, **4.84 / 7.80**), under **Waiting on you**. It's Sam's move. Same pill metrics as every pill (§6.2). It replaces a bare `You owe $15.10`; never both. Because the flag clears his mark, the bill comes back out of **Hidden** into **Waiting on you**. That move is the signal, so the pill must explain it (a bare `You owe` would look like a bug).

```
Waiting on you
┌───────────────────────────────────────────────┐
│ Raj's bill                          $14.80  › │
│ Nov 24 · 4 people               Your share    │
│ (Not received · $14.80)                       │  accent
└───────────────────────────────────────────────┘
```

Sam's own sent bills: once he sends his full share, the bill leaves **Waiting on you** for **Hidden** (guest, paid in full). Leaving the list is the quiet "done" signal on Home. His own pills (`Sent $15.10`, `Paid $15.10 in cash`) show only where Hidden rows are shown, with the same muted look.

## 6. Home "sent" pills in Owed to you (SV-VIS-11)

### 6.1 Tone and placement
**Muted** (`textMuted` on `surfaceMuted`, **6.79 / 7.04**), no icon, in the row's existing pill slot under the caption. The row sits under **Owed to you** (the payer, someone still owes), where its pill was `N people left to pay`. The `sent` pill swaps the words on a row that doesn't move. List order inside the group is kept (HR-9): no floating news to the top, so rows don't reshuffle each time someone pays.

Why muted in a group called "Owed to you": colour on Home means "your move" (SE-VIS-1). An arrival is news, not a task. The words "sent you" stand out among `1 person left to pay` without colour. The only accent pill in this group stays `N differences to settle` (the payer has something to do), which wins over `sent` anyway (SV-21).

```
Before                                         After
Owed to you                                    Owed to you
┌──────────────────────────────────────┐       ┌──────────────────────────────────────┐
│ Your bill                $44.80    › │       │ Your bill                $44.80    › │
│ Nov 26 · 3 people         Total      │       │ Nov 26 · 3 people         Total      │
│ (2 people left to pay)               │  ──▶  │ (Sam sent you $15.10)                │  muted
│──────────────────────────────────────│       │──────────────────────────────────────│
│ Your bill                $90.00    › │       │ Your bill                $90.00    › │
│ Nov 20 · 5 people         Total      │       │ Nov 20 · 5 people         Total      │
│ (3 people left to pay)               │  ──▶  │ (2 people sent you money)            │  muted
│──────────────────────────────────────│       │──────────────────────────────────────│
│ Your bill                $38.10    › │       │ Your bill                $38.10    › │
│ Nov 25 · 3 people         Total      │       │ Nov 25 · 3 people         Total      │
│ (1 difference to settle)             │       │ (1 difference to settle)             │  accent; beats sent
└──────────────────────────────────────┘       └──────────────────────────────────────┘
```

**The last payment (needs splitit-app-96's grouping rule, proposal P4).** When Sam's send is the one that settles the bill, the bill's group becomes **Settled**, which is collapsed. The news Hana most wants ("everyone's paid me") would then be folded away. Recommended: **while a bill shows an unseen `sent` pill, it stays in Owed to you**, and it moves to Settled when Hana opens it or the pill ages off (72 h). Then the row reads:

```
Owed to you
┌──────────────────────────────────────┐
│ Your bill                $62.00    › │
│ Nov 18 · 3 people         Total      │
│ (Sam paid you $15.10 in cash)        │  muted; moves to Settled once seen
└──────────────────────────────────────┘
```

That's their file (`lib/homeSections.ts`) and their grouping decision. **I didn't decide it.** If they keep "everyone paid → Settled" strictly, the pill still renders in Settled when the group is expanded, with the same look, and the collapsed Settled header gets no badge or count (HR-18, no counts in headings).

### 6.2 Pill metrics (unchanged, all pills)
`type.caption` 13/18 at 600; padding 8 × 2; `radius.pill`; under the caption with `gap: space.xs`; hugs its text; `maxWidth: '100%'` so it wraps and never truncates.

### 6.3 Width at 375 pt
The left column of a Home row at 375 pt is about 311 − trailing (amount ~60 + label + chevron 20 + gaps ~16) ≈ **215 pt**. At 13/600:

| Pill | Width incl. padding | Fits on one line |
|---|---|---|
| `Sam sent you $15.10` | ~135 | yes |
| `2 people sent you money` | ~165 | yes |
| `Sam paid you $15.10 in cash` | ~185 | yes |
| `Not received · $15.10` | ~145 | yes |
| `Alexandra paid you $150.10 in cash` | ~230 | **no**: wraps to a two-line capsule |

A two-line pill is acceptable (SE-VIS-1 §1.2 already allows it at large text), but it'll show up at default size with long names. See proposal P1. At the largest text sizes every pill wraps, as today.

## 7. Footer captions (SV-VIS-12, SV-VIS-13)

Layout and type are today's (SE-VIS-8): `[Settle up]` + caption in one wrapping row, `gap: space.md`; captions `type.caption`, `textMuted`, regular. A success caption keeps today's `ToneIcon` check drawn in `textMuted`. The footer stays chrome, and the primary carries the emphasis.

| State | Button | Caption | Icon |
|---|---|---|---|
| Ready, marked | secondary `Settle up` | `Sent to Hana · $15.10` / `Paid Hana in cash · $15.10` / `Marked paid · $15.10` | check, `textMuted` |
| Early, marked | secondary | `Sent via Venmo · 1 item left to claim` / … | check, `textMuted` |
| Payer, all settled | secondary | `Everyone's settled up` | check, `textMuted` |
| **Not received (U!)** | primary `Settle up` | `Hana hasn't received your $15.10` | **TriangleAlert in `warning`**, text `textMuted` |
| Others | unchanged | unchanged | |

**The one coloured icon in the footer (SV-VIS-13):** the not-received triangle is drawn in `warning` (7.52 / 11.18 on `surface`); the words stay muted. It's the only footer state where something went wrong that Sam didn't do himself, and the shape alone in grey next to a filled button was easy to miss. A 16-pt icon doesn't compete with the filled button beside it.

```
Ready, marked                                Not received
┌─────────────────────────────────────┐      ┌─────────────────────────────────────┐
│ [Settle up]  ✔ Sent to Hana · $15.10│      │ [▓▓ Settle up ▓▓]  ▲ Hana hasn't    │
└─────────────────────────────────────┘      │                    received your    │
  secondary   check + caption muted          │                    $15.10           │
                                             └─────────────────────────────────────┘
```

**Cash footer** (SV-UX-10): the Pay footer's layout exactly: block primary `I paid Hana $15.10 in cash`, then the row with (no notes) and `Details` flush right. The same button shape in the same place for either method.

**Check-in footer** (replaces `did_you_pay` while the inline question applies):
```
┌─────────────────────────────────────┐
│ Did your $15.10 to Hana go through? │  label 15/600 text (today's question style)
│ Yes    No, undo              Details│  ghost, ghost … ghost
└─────────────────────────────────────┘
```
No primary: doing nothing already means "yes", so neither answer is the default to push. Both are flush ghosts, 16 apart (a nested row with `gap: space.lg`, like the card), and `Details` stays at the right, where it is under Pay. The fallback `did_you_pay` (contract O) keeps today's look with the new copy: primary `Yes, I sent it`, ghost `Not yet`.

| Pair | Light | Dark |
|---|---|---|
| `textMuted` on `surface` (captions) | 7.56 | 7.98 |
| `warning` on `surface` (triangle, a UI icon: needs 3:1) | 7.52 | 11.18 |
| `text` on `surface` (check-in question) | 17.74 | 15.72 |

## 8. Contrast summary, every pair this slice uses

All existing tokens; computed from the hex values in `lib/theme.ts` (WCAG 2.x).

| Pair | Where | Light | Dark | Passes |
|---|---|---|---|---|
| `onPrimary` / `primary` | selected segment, primaries | 5.47 | 9.18 | AA text |
| `text` / `surfaceMuted` | unselected segment | 15.95 | 13.86 | AA text |
| `primary` / `surfaceMuted` | selected thumb vs track | 4.92 | 8.20 | 3:1 UI |
| `primary` / `surface` | ghosts, TextLink, thumb vs card | 5.47 | 9.29 | AA text |
| `success` / `surface` | sent/paid lines, row statuses | 5.69 | 10.69 | AA text |
| `warning` / `surface` | not-received line, footer triangle | 7.52 | 11.18 | AA text |
| `textMuted` / `surface` | question, completion line, notes, captions | 7.56 | 7.98 | AA text |
| `text` / `surface` | labels, footer question | 17.74 | 15.72 | AA text |
| `primary` / `primarySurface` | accent pill (`Not received · $X`) | 4.84 | 7.80 | AA text |
| `textMuted` / `surfaceMuted` | muted pills (`sent you`) | 6.79 | 7.04 | AA text |
| `danger` / `dangerSurface` | confirm buttons | 6.05 | 8.24 | AA text |
| `text` / `warningSurface` | confirm banner text | 17.00 | 13.41 | AA text |
| `warning` / `warningSurface` | confirm banner icon | 7.21 | 9.54 | 3:1 UI |
| `danger` / `warningSurface` | danger label read against the banner | 6.30 | 7.60 | AA text |

Shapes not relied on (grouping tints): `surfaceMuted`/`surface` 1.11/1.13, `primarySurface`/`surface` 1.13/1.19, `dangerSurface`/`warningSurface` 1.04/1.08.

## 9. Checks at 375 pt and at large text (estimates; nothing is built)

| Surface | 375 pt, default text | Largest accessibility text |
|---|---|---|
| Chooser | ~137 pt track on a 311-pt inner width | ~240 pt; grows, never clips |
| Long primary `I paid Hana Lee-Watanabe $15.10 in cash` | 2 lines, centred (Button `flexShrink`, SE-VIS-10) | 3–4 lines; the button grows (`minHeight` 44) |
| Not-received line | 2 lines beside the icon | 4–5 lines; icon on line 1 |
| Inline answers `Yes` `No, undo` | one row, ~107 pt | wraps to two lines, both flush start, 4-pt row gap |
| Payer method line `2 sent via Venmo · 1 paid in cash` | 1 line (~250 pt incl. icon) | 3 lines, wrapped under the first word |
| Row status `Sent via Venmo` | 1 line in the 120 column; name gets ~117 pt | wraps inside the column; the column drops to its own line flush right (existing `marginLeft: 'auto'`) |
| `Not received` link | 1 line, ~80 pt | 1–2 lines, flush right |
| Footer `[Settle up] ▲ Hana hasn't received your $15.10` | caption 2 lines in ~160 pt beside a primary (≤ 36 pt, inside the 44 button height) | the row wraps; caption under the button |
| Home pills | §6.3 | every pill wraps inside the row, as today |

## 10. For the engineering design (model and primitive changes this design needs)

**Primitives (`components/ui/`, visual or a11y only; check every user):**
- `SegmentedControl`: a `disabled` prop (opacity 0.5, not pressable, `accessibilityState.disabled`), and radio semantics for this use: an `accessibilityRole`/group-label option so the track is a `radiogroup` labelled `How you're paying` and each segment a `radio` with `checked`. Today segments are `button` + `selected`. The BillForm and TipOptions controls keep their current semantics unless the a11y owner wants radios there too. **This changes a11y semantics, so it's the engineer's call, not a visual change.**
- `Button`: flush content aligned to the leading or trailing edge (e.g. `flush: 'start' | 'end'`, with `true` = today's centred behaviour). The card's ghost rows use `start`, row controls `end`. Users: `SettleCard` secondary row and inline check, `SettlePeopleList` row controls, `SettleFooter` `Details` / `Not yet`. Visible effect: short ghost labels move up to 8 pt onto their column edge.
- `TextLink`: `minWidth: TOUCH_TARGET` (the label stays leading), plus `disabled` and `loading` (a small `ActivityIndicator` in `primary` in place of the icon). Users today: Add note, Tip options, Show QR code, Make a new link, Type items instead on Home. All labels are wider than 44, so none of them changes.

**View models (`lib/settleView.ts`, `lib/homeMarkers.ts`):**
- `SettleCardModel.chooser: { options: { value: PaymentMethod; label: string }[]; value: PaymentMethod; a11yLabel: string } | null`. Null with fewer than 2 methods. Rendered between the lines and the primary (§1.2).
- `SettleCardModel.check: { question: string; yes: SettleButton; undo: SettleButton } | null`. While non-null, the model's `secondary` must not contain the card's Undo (brief §4.2). The completion line is an ordinary muted `CardLine` after the success line, absent while `check` is non-null.
- `SettleRowModel.notReceived: { a11yLabel: string; a11yHint: string; confirmText: string } | null`, **separate from `undo`**, because it renders as a `TextLink`, not a ghost `Button`. `undo` stays for the host who isn't the payer. A row never has both.
- `SettlePeopleModel.wideStatus`: also true when any row shows a method status (`Sent via Venmo`, `Paid in cash`, `Paid`), not only difference statuses (§4.1).
- `SettleFooterAction`: a `cash` kind with the `pay` kind's shape; a `sent_check` kind (`text`, `yes`, `undo`, `details`); `settle.tone` gains `'warning'` (triangle in `warning`, text muted).
- `MarkerView` for `sent` → `tone: 'muted'`, for `not_received` → `tone: 'accent'`, `icon: null` for both (the pill ignores `icon` anyway).
- Home groups v2 (splitit-app-96, not this slice): `not_received` in the Waiting set; `sent` rows in Owed to you; P4's rule if they accept it. Nothing here edits their files.

**Motion:** an `Animated.View` with `layout={LinearTransition.duration(200).reduceMotion(ReduceMotion.System)}` around the Settle screen's card stack, native only (§2.4). Optional.

## 11. Proposals that need a copy or behaviour decision (not decided here)
- **P4. An unseen `sent` keeps the bill in Owed to you (Home groups v2).** Without it, the final payment's pill lands in the collapsed Settled group (§6.1). A grouping rule in splitit-app-96's `lib/homeSections.ts`: a payer bill with a `sent` marker sorts into Owed to you even when everyone has paid. Their call; it needs one condition, not a new group.
- **P1. First names in Home pills.** `Alexandra Lee-Watanabe paid you $15.10 in cash` wraps into a two-line capsule at default text size. Using the first word of the display name in pills only (`Alexandra paid you …`) keeps them on one line. The row's a11y label could keep the full name. Copy change, so it's the PM's call.
- **P2. Card question wording.** `Did it go through?` is good. If testers miss that "Yes" needs no tap, an optional muted suffix `You can ignore this if it did.` would say so, but it adds a line. Not recommended now; listed for the friend test.
- **P3. Danger button on a warning banner.** In both inline confirms (existing row Undo, new Not received and Undo all), the tonal red button's shape is 1.04 / 1.08 against the amber banner. The label carries it, but a later primitives pass could give `Banner` confirms a ghost-danger (text-only red) button. Applies app-wide, so it isn't done in this slice.

## 12. Not verified
I couldn't see any of this: none of it is built. Widths (segments ~73/58 pt, statuses ~98/115 pt, pills §6.3, the 215-pt Home column) are estimates for the system font at 13/600 and 15/600. Check once built: the hug-mode chooser next to the full-width primary in both schemes (does it read as a setting, not a button?), the 120-pt status column with `Sent via Venmo` at 375 pt, the `Not received` link's distance from neighbouring controls on a back-due row, the two-line pills with long names, the footer triangle in dark, and the 200-ms layout transition with Reduce Motion on and off on an iPhone.
