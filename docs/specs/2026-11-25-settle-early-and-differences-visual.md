# Settle early and differences: visual design

Date: 2026-11-25. Third document for this feature. It follows the spec (`docs/specs/2026-11-25-settle-early-and-differences.md`, data and money) and the UX brief (`docs/specs/2026-11-25-settle-early-and-differences-ux.md`, layout, states, copy). This one covers only how things look: tones, type, spacing, alignment and wrapping. The user reviews all three before anything is built. **No code was changed.**

Every value here is an existing token from `lib/theme.ts` or an existing primitive in `components/ui/`. **No new colours or tokens.** Decisions are logged as SE-VIS-1 … SE-VIS-10 in `docs/decisions-to-review.md`. Two of them change what the spec's view models return (SE-VIS-1 pill `tone`, SE-VIS-6 a `wideStatus` flag). §8 lists them for the engineering design.

Built from: the spec and brief; `lib/theme.ts`; `components/ui/{Button,Card,Banner,StatusLine,ListRow}.tsx`; `components/{SettleCard,SettlePeopleList,SettleFooter,AddedNotice,Avatars}.tsx`; `app/(app)/index.tsx`; QA screenshots of Home (light/dark, many pills), Settle (owes, payer) and the bill footer; the `ui-ux-designer` and `expo-design-system` skills; the `[area: expo]` lessons (simple and uncluttered, one primary, dark-mode avatar contrast).

## 0. Audit of today's look (what this design keeps and fixes)

| Surface | Works today | Problem for this feature |
|---|---|---|
| Home rows | Label + one small pill under it; pill = words on a tint; calm in both schemes (screenshots) | The brief adds 7 pills in 4 tones (teal, grey, green, amber). On one list that reads like a rainbow, and teal "New" next to green "Paid" are close in hue but mean different things |
| Settle card | Clear focal point: label → 32-pt amount → caption lines → one block primary → ghost secondaries | Long Pay labels ("Pay Hana Lee-Watanabe $1.10 more on Venmo") can overflow: `Button`'s label `Text` sits in a row with no `flexShrink`, so it can run past the button edge on native instead of wrapping |
| Everyone list | One line per person: name (flex), money, status column (`minWidth: 64`, right-aligned) | New statuses ("You owe $1.10 back", ~120 pt) are wider than 64 pt, so their money would sit further left than the other rows' and the money column stops lining up. A wrapped status falls to the left edge, not under the status column |
| Footer | `[Settle up][muted caption]` side by side; quiet | Longer captions are fine (they wrap), nothing to fix beyond keeping them quiet |
| Avatars (dark) | Initials text is readable (13.86:1) | The circle disappears: `surfaceMuted` on `surface` is 1.13:1, and the 2-pt cut-out ring is the same colour as the card. In the "Add people" dark screenshot the initials float with no shape |

Native-slop check: no cards added, no emoji icons (✓ and ⚠ are the existing text glyphs, brief §Providers), no modals, no motion.

## 1. Home pill system

### 1.1 The rule: two tones, by "is it your move?"
Colour is kept for one meaning only. **Accent** = "this bill wants something from you". **Muted** = everything else: waiting on others, information, and finished. Done states are the quietest thing on the list, because a finished bill is something you no longer need to look at. The `✓` and the words ("Paid", "Settled up") already say it's done, so it doesn't need green.

No success-green or warning-amber pills on Home. Green and amber stay in the Settle screen, where status lines and banners already use them and there is room to explain.

| Pill | Tone | Why |
|---|---|---|
| New | accent | unchanged: open it |
| Nothing claimed yet | muted | unchanged |
| You owe $15.10 | accent | your move: pay |
| ✓ Paid $15.10 | muted | done |
| Paid · $1.10 more to pay | accent | your move: pay the difference |
| Paid · $1.10 back to you | muted | the payer's move (you can only nudge) |
| 1 person left to pay / N people left to pay | muted | waiting on others |
| 1 difference to settle / N differences to settle | accent | open it: rows need your attention (pay back, or request) |
| ✓ Settled up | muted | done |

So a typical list shows teal only where you're needed, and grey for everything else.

### 1.2 Pill spec (all pills identical apart from the two colour pairs)
Unchanged from today's `MarkerPill`, so existing pills don't move:

| Property | Value |
|---|---|
| Text | `type.caption` (13/18) + `fontWeight: '600'` |
| Accent | text `primary`, background `primarySurface` |
| Muted | text `textMuted`, background `surfaceMuted` |
| Padding | `space.sm` (8) horizontal, 2 vertical (height 22 at default size) |
| Radius | `radius.pill` |
| Glyph | `✓` stays a text glyph inside the string, same colour as the words. No icon component: a 16-pt lucide icon is too large for a 13-pt pill and the smaller size isn't a token |
| Border | none |
| Placement | under the row label, `gap: space.xs` (4); the pill's box is left-aligned with the label text; the row's chevron stays vertically centred on the whole row |
| Size | hugs its text (`alignSelf: 'flex-start'` via the row's `alignItems: 'flex-start'`) |
| Large text | never truncates; wraps inside the pill. The pill radius stays `pill` (a two-line capsule is acceptable at accessibility sizes) |
| Screen readers | unchanged: the pill isn't read separately; the row label carries it (brief §6.3) |

One pill per row, always. No icon, dot or count badge next to it.

### 1.3 Contrast (WCAG 2.x, computed from the hex values in `lib/theme.ts`)

| Pair | Used by | Light | Dark |
|---|---|---|---|
| `primary` on `primarySurface` | accent pills | **4.84:1** | **7.80:1** |
| `textMuted` on `surfaceMuted` | muted pills | **6.79:1** | **7.04:1** |
| `primarySurface` on `surface` (pill shape) | | 1.13:1 | 1.19:1 |
| `surfaceMuted` on `surface` (pill shape) | | 1.11:1 | 1.13:1 |

Both text pairs pass AA for 13-pt text (4.5:1). The pill shape itself is low-contrast by design: it's a non-interactive grouping tint, the words carry the meaning, so WCAG 1.4.11 (3:1 for UI parts) doesn't apply. Not used on Home but computed for reference (the brief asked): `success` on `successSurface` 5.40 / 9.48, `warning` on `warningSurface` 7.21 / 9.54.

### 1.4 Before / after
```
Before (brief §6.2 tones)                After
Ana's bill · $38.00          ›          Ana's bill · $38.00          ›
(New)                      teal         (New)                      teal
Hana's bill · $44.80         ›          Hana's bill · $44.80         ›
(You owe $15.10)           teal         (You owe $15.10)           teal
Dee's bill · $61.00          ›          Dee's bill · $61.00          ›
(✓ Paid $20.00)           green         (✓ Paid $20.00)            grey
Hana's bill · $44.80         ›          Hana's bill · $44.80         ›
(Paid · $1.10 more to pay) amber        (Paid · $1.10 more to pay) teal
Your bill · $62.00           ›          Your bill · $62.00           ›
(2 people left to pay)     grey         (2 people left to pay)     grey
Your bill · $48.00           ›          Your bill · $48.00           ›
(1 difference to settle)   amber        (1 difference to settle)   teal
Your bill · $90.00           ›          Your bill · $90.00           ›
(✓ Settled up)            green         (✓ Settled up)             grey
```
Four hues become two. The eye goes straight to the teal rows.

## 2. Settle card states

### 2.1 What every state shares (today's card, unchanged)
- `Card` (padding `space.lg`, gap `space.md`, `radius.lg`, continuous corners, hairline `divider` edge).
- **Head group** (`gap: space.xs`): label `type.label` in `text` → amount `MoneyText size="display"` (32/38/700, tabular) → caption lines.
- **Action group** (`marginTop: space.xs`, `gap: space.sm`): the one block button → notes (`type.caption`, `textMuted`).
- **Secondary row**: ghost buttons, `gap: space.lg`, wrapping, flush left (`paddingHorizontal: 0`, `minWidth: TOUCH_TARGET`).
- Rhythm: 4 inside a group, 12 between groups (card gap), +4 above the button so it gets 16 of air.

Caption line tones (`CardLine.tone`), used consistently across every new state:

| Tone | Style | Meaning | Contrast on `surface` L / D |
|---|---|---|---|
| muted | `type.caption`, 400, `textMuted` | explanation, nothing to do | 7.56 / 7.98 |
| success | `type.caption`, 600, `success` | a confirmed fact (`✓ Marked paid`, `✓ Hana paid you back.`) | 5.69 / 10.69 |
| warning | `type.caption`, 600, `warning` | needs attention (`⚠ 1 difference to settle`) | 7.52 / 11.18 |

**One primary per card, at most.** Every new explanatory line (may change, pending, diff) is muted. No new tone, icon, border or tinted block inside the card.

### 2.2 The "may change" line (A1, A3, after-Pay, no-Venmo)
A muted caption, the last line of the head group, so it sits between the amount and the Pay button: read before paying, but quieter than both. Regular weight; not live.
```
You owe Hana                       label 15/600
$15.10                             display 32/700
Your share may change until        caption 13, textMuted, 400
everything is claimed (1 item left).
                                   (16 pt)
[     Pay Hana $15.10 on Venmo     ] primary block
@hana-1 · $15.10                   note
I already paid                     ghost
```
Before: the same card without the line (screenshot `light-01`). After: one quiet line; nothing else moves.

### 2.3 Marked early (A4, A5)
`✓ Marked paid` (success, 600) then the muted explanation directly under it (same group, 4 pt), then the ghost `Undo`. A5's `Your share is now $16.20. You'll pay the $1.10 difference …` is muted too, as the brief says: no ⚠, no warning colour next to a green check.

### 2.4 The difference block (B1, B3, B4)
The difference **is** the card's amount: label → display amount (the difference, never the totals) → one muted line with the two totals. No mini-table, no "old → new" figures, no coloured amount.
```
B1 more_due                              B4 back_due
You owe Hana more        label           Hana owes you           label
$1.10                    display         $1.10                   display
Your share is now $16.20. You've         Your share is now $14.00. You've
marked $15.10 paid.      muted           marked $15.10 paid.     muted
[ Pay Hana $1.10 more on Venmo ] PRIMARY [ Request $1.10 from Hana on Venmo ] SECONDARY
@hana-1 · $1.10          note            @hana-1 · $1.10         note
I paid the difference   Undo "I paid"    Undo "I paid"           ghost
```
- B3 (no Venmo): the extra muted line `Hana hasn't added Venmo yet…` joins the head group; `I paid the difference` becomes the primary block; `Undo "I paid"` alone in the secondary row.
- B4 below $0: the extra `Hana also owes you $1.00 …` line is muted, directly under the diff line.
- B4 no Venmo: no button; `Ask Hana to pay you back.` is a muted line; `Undo "I paid"` stays.

### 2.5 Request vs Pay (SE-VIS-3)
| Button | Variant | Why |
|---|---|---|
| Pay … on Venmo, Pay … more on Venmo | **primary** (filled, block) | finishes your part |
| I paid the difference (B2, B3) | **primary** | finishes your part |
| Request $1.10 from Hana on Venmo (B4) | **secondary** (outline, block) | a nudge: it never records anything and doesn't finish the bill; Hana does. A filled button would promise "tap this and you're done" |
| I paid the difference (B1), Open Venmo again, Undo "I paid", I already paid | ghost | secondary paths |

So B4 has **no primary**. Its focal point is the amount `$1.10` under "Hana owes you", which is what the person came to see. Outline uses `primary` text on `surface` with a `border` edge (5.47 / 9.29 text; 3.74 / 3.75 edge), the same as "Add Venmo" on Home.

B1's secondary row: `I paid the difference` first, `Undo "I paid"` second, `gap: space.lg` (16). At 375 pt the inner width is 311; the two labels need about 150 + 16 + 95 = 261, so they fit on one line at default size and wrap to two lines at larger sizes, both flush left.

### 2.6 Long button labels (SE-VIS-10, `Button` primitive)
`Pay Hana Lee-Watanabe $1.10 more on Venmo` must wrap and the button must grow (brief §11). Today the label `Text` sits in a row with no `flexShrink`, so on native it can run past the button. Fix in `components/ui/Button.tsx`: label `Text` gets `flexShrink: 1` and `textAlign: 'center'`. Buttons with one-line labels look exactly the same. It affects every button in the app, which is the point: any long label wraps, centred, and `minHeight: 44` lets the button grow.

### 2.7 After a recorded difference (B7) and ±1¢ (B6)
Both are today's marked card (M3 3.3), pixel for pixel: `You paid Hana` / display amount (net, or the mark for ±1¢) / `✓ Marked paid` (success) / ghost `Undo`. No sub-line, no history, no hint of a cent. Nothing new to style.

### 2.8 Paid back to $0 (B5)
```
You're all set                         label
You don't owe anything on this bill.   muted
✓ Hana paid you back.                  success 600, polite live
```
No amount, no buttons (as M3 3.6). The success line comes last so the eye ends on the resolution.

### 2.9 Payer's card (A6, 3.C)
- A6: label `Waiting for everyone to claim` with **no amount**, two muted lines. Same label style as every other card; no bigger type to fill the space left by the missing amount. The tonal "Add your Venmo" card above it stays the screen's one primary.
- 3.C: `3 of 3 paid` muted, then `⚠ 1 difference to settle` warning 600. This is the only warning line on the payer's card. Inside Settle, warning still means "look here", which matches the warning-toned row status below it (§3.3).

## 3. Everyone list rows

### 3.1 Row anatomy (today's, kept)
`row`: `paddingVertical: space.sm`, `gap: space.xs`, hairline `divider` between rows.
1. **Main line** (one accessible element, the row label): name (`type.body`, `text`, `flex: 1`, `minWidth: 96`) · money (`MoneyText`, body, tabular) · status (`type.caption` 600, right-aligned). `alignItems: 'baseline'`, `columnGap: space.md`, wraps.
2. **Sub-line**: `type.caption`, `textMuted` (ready difference rows lose the ⚠, SE-UX-5).
3. **Control line(s)**: muted `@handle` on the left (`numberOfLines={1}`, hidden from screen readers), ghost button flush right.

### 3.2 Keeping the money column straight (SE-VIS-6)
The money column lines up because every status column is the same width. Short statuses (`Not yet`, `✓ Paid`) fit today's `minWidth: 64`; difference statuses don't (`Owes $1.10 more` ≈ 100 pt, `You owe $1.10 back` ≈ 120 pt, `Hana owes $1.10 back` ≈ 135 pt at 13/600).

Rule: **when any row in the list has a difference status, every row's status column is a fixed `width: 120`** (a local layout constant with a comment, not a token: one use) and status text wraps inside it, right-aligned. Otherwise it stays `minWidth: 64` as today, so lists without differences don't change at all. The component needs to know this without parsing strings, so `SettlePeopleModel` gains `wideStatus: boolean` from `lib/settleView.ts` (§8).

At 375 pt (inner 311): name gets 311 − 120 − ~50 money − 24 gaps ≈ 117 pt, room for "Alexandra" on one line; longer names wrap under themselves, and money and status stay on the first line (baseline).

At large text sizes, the main line wraps as today. Add `marginLeft: 'auto'` to the status so a status that drops to its own line stays **flush right** under the money instead of jumping to the left edge.

### 3.3 Status tones
| Status | Tone | Contrast on `surface` L / D |
|---|---|---|
| `Not yet`, `Owes $1.10 more`, `You owe $1.10 more` (own row), `Hana owes $1.10 back`, `Hana owes you $1.10 back` | muted | 7.56 / 7.98 |
| `You owe $1.10 back` (payer's view only) | **warning** | 7.52 / 11.18 |
| `✓ Paid`, `✓ Paid back` | success | 5.69 / 10.69 |

At most one warning status per row; the sub-line under it is always muted.

### 3.4 Control lines and the 44-pt target
```
Ana              $14.00   You owe $1.10   ← status wraps inside its 120-pt column
                                   back
Marked $15.10 · share now $14.00          ← sub-line, muted
@ana-1                    Pay $1.10 back  ← handle left (ellipsizes), ghost right
                          I paid it back  ← second ghost, own line, flush right
```
- Every control is a `Button variant="ghost"`: `minHeight: 44`, `minWidth: 44`, `paddingHorizontal: 0`, so its text right edge lines up with the status and money above it. Stacked controls each keep a full 44-pt height, `space.xs` (4) apart (the row's gap).
- **The handle gives way, the button never does.** The handle is `flex: 1, minWidth: 0, numberOfLines: 1` and ellipsizes (`@alexandra-lee-wat…`); it's a visual fallback only, and the button label carries the handle for screen readers. The button label never truncates.
- At large text, if the button doesn't fit beside the handle, the control line wraps: give the button `marginLeft: 'auto'` so it lands flush right on its own line.
- Captions that replace a button (`Hasn't added Venmo`, `Pay it back in the Venmo app`) are muted captions on the left, where the handle would be.
- Host-not-payer `Undo` keeps today's flush-right ghost.
- The new polite caption slot for `Marked paid back` (SE-UX-12) sits after the rows and before the web footnote: muted caption, same as the card's `announcement`.

Before: `Sam  $15.10  Not yet` / `@sam-1  Request`. After: the same layout. Difference rows add a sub-line and up to two right-aligned controls, and the status column widens only when needed.

## 4. Bill-screen footer captions
The layout is today's `settle` footer: `[Settle up]` + caption in one row (`gap: space.md`, `alignItems: 'center'`, wrapping). Primary: the button and the caption share the width (both `flex: 1`). Secondary: the button hugs its label and the caption takes the rest.

| State | Button | Caption |
|---|---|---|
| Early, unmarked | primary | `You can pay now · 1 item left to claim` |
| Early, marked | secondary | `✓ Marked paid · 1 item left to claim` |
| Ready, more due | primary | `You owe Hana $1.10 more` |
| Ready, back due | primary | `Hana owes you $1.10 back` |
| Payer, differences | primary | `1 difference to settle` |

All captions are `type.caption`, `textMuted`, regular weight, **including the ✓** (SE-VIS-8). The footer is chrome under the content. The primary button already carries the emphasis, and a coloured caption next to it would be a second focal point. The amounts don't need tabular numerals here (no column).

Wrapping: at half of a 375-pt footer (~160 pt), short captions take 1–2 lines (≤ 36 pt, inside the 44-pt button height, so the footer doesn't grow). The longest (`You can pay now · 2 items and 1 discount left to claim`) takes 3 lines (54 pt). The row grows a little and the button stays vertically centred. Acceptable; see proposal P2.

## 5. Light and dark

Every pair used above is an existing token pair, and every text pair is ≥ 4.5:1 in both schemes (numbers in §1.3, §2.1, §3.3). Dark mode needs nothing extra for this feature.

### 5.1 Avatars fix (SE-VIS-9)
Problem (QA, lessons 2026-11-24): the avatar circle is `surfaceMuted` on `surface` (1.11 light / 1.13 dark), with a 2-pt ring in `surface` colour. In dark mode the shape disappears and only the initials remain.

Fix, in the style the app already uses for outline controls (secondary `Button`, `TextField`): **a 1-pt ring in `border`** around other people's avatars.

| Avatar | Fill | Ring | Initials |
|---|---|---|---|
| Others | `surfaceMuted` (unchanged) | 1 pt `border` (was 2 pt `surface`) | `text`, `type.micro` |
| You | `primary` (unchanged) | 1 pt `primary` (same as fill, so it looks ringless) | `onPrimary` |

| Pair | Light | Dark |
|---|---|---|
| ring `border` vs card `surface` | **3.74:1** | **3.75:1** (≥ 3:1 for a UI shape) |
| initials `text` on `surfaceMuted` | 15.95:1 | 13.86:1 |
| initials `onPrimary` on `primary` | 5.47:1 | 9.18:1 |

Overlapping avatars (`marginLeft: -6`) still separate: fills are opaque, so each ring cuts across the one under it. `borderWidth: 1` rather than `hairlineWidth`, because a 0.33-pt ring on a 3× screen is too faint to fix the problem. Size stays 24. It applies wherever `Avatar` is used (claim rows, Add people, people lists). The `border` token is already defined as "≥ 3:1 against surface", so no new colour is needed.
```
Before (dark)        After (dark)
 HM  Hal Moss         (HM) Hal Moss      ← thin grey ring makes the circle visible
```

## 6. Before / after summary
| Surface | Before | After |
|---|---|---|
| Home | 2 pills, teal + grey | 9 pills, still only teal (your move) + grey (everything else) |
| Settle card | M3 states | New states reuse the same anatomy; new lines are muted captions; Request is outline, Pay is filled; long labels wrap |
| Everyone | name · money · short status | Same; status column widens to 120 only when a difference exists; up to two flush-right ghost controls on their own lines |
| Footer | `Settle up` + muted caption | Same layout, new muted captions |
| Avatars | Shape invisible in dark | 1-pt `border` ring |

## 7. Proposals that need a copy decision (not decided here)
- **P1. Difference sub-line repeats the share.** On a ready difference row the money column already shows `$16.20`, and the sub-line says `Marked $15.10 · share now $16.20`. Shorter: `Marked $15.10 paid`. One less number per row. Copy change, so it's the PM's call.
- **P2. Longest early footer caption.** `You can pay now · 2 items and 1 discount left to claim` takes three lines in half a footer. Option: count everything as "left", e.g. `You can pay now · 3 left to claim`, and keep the detailed count on the Settle card. Copy change.

## 8. For the engineering design (model or primitive changes this design needs)
- **Pill tone** (SE-VIS-1): `billMarkerView(...).tone` becomes `'accent' | 'muted'`. Spec H1–H7 tone column: H1 accent, H2 muted, H3 accent, H4 muted, H5 muted, H6 accent, H7 muted. Criterion 35's expected tones change; criterion 44 ("keeps its words in every tone") still holds. `MarkerPill` maps `accent` → `primarySurface`/`primary`, `muted` → `surfaceMuted`/`textMuted`. `new` is accent and `unclaimed` muted, as today.
- **`SettlePeopleModel.wideStatus`** (SE-VIS-6): true when any row's status is a difference status.
- **`Button` label** (SE-VIS-10): `flexShrink: 1`, `textAlign: 'center'` on the label `Text`.
- **Card Request variant** (SE-VIS-3): `SettleCardModel` needs to say the B4 Request is outline, not primary. For example a `secondaryBlock` slot, or a `variant` on `SettleButton`. `SettleCard` today renders `primary` always as filled.
- **Row layout**: status `marginLeft: 'auto'`; control-line button `marginLeft: 'auto'`; second control on its own line, `alignSelf: 'flex-end'`.
- **Avatar** (SE-VIS-9): `borderWidth: 1`, `borderColor: isMe ? primary : border`.

## 9. Not verified
I couldn't see these screens: they don't exist yet. Widths (≈100/120/135 pt statuses, ≈150 pt ghost labels) are estimates for the system font at 13/600 and 15/600. Check at 375 pt, at the largest Dynamic Type size, and in both schemes once built, especially §3.2's 120-pt column and §4's three-line caption.
