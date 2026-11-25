# Settle early, differences and Home settle markers: UX brief (screens)

Date: 2026-11-25. Companion to `docs/specs/2026-11-25-settle-early-and-differences.md` (the "spec"). The spec owns data, contracts and money math (rules E and Z, contract D, H1–H7). This brief owns layout, states, copy and accessibility. It extends the M3 brief `docs/specs/2026-11-24-m3-settle-ux.md` (section numbers like "3.3" refer to it) and keeps its rules. The user asked for plans, then UX/UI design, then eng design, and will review all three before code. A visual designer styles from this brief next, then a staff engineer reviews the technical side.

The user asked not to stop for questions. Every choice here is decided and logged as SE-UX-1 … SE-UX-17 in `docs/decisions-to-review.md` ("2026-11-25 · Settle early and differences, UX brief"). §9 lists which ones change the spec.

Built from: the spec; the M3 brief; `lib/settleView.ts` (copy and models today); `components/SettleCard.tsx`, `components/SettlePeopleList.tsx`, `components/SettleFooter.tsx`; `app/(app)/bills/[id]/settle.tsx`; `app/(app)/index.tsx`, `components/AddedNotice.tsx`, `lib/homeMarkers.ts`; `docs/learning/concepts/in-app-notices.md`; `.claude/skills/ui-ux-designer/SKILL.md`; the `[area: expo]` lessons (copy at a count of 1 and with "You"; refetch failure re-enables; one home per action).

Worked example throughout: **Hana** is the payer (`@hana-1`), **Sam** is the viewer who owes (`@sam-1`), **Dee** is the host when the host isn't the payer. Sam marked $15.10. "Up" means his share is now $16.20 (+$1.10). "Down" means it's now $14.00 (−$1.10).

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| None beyond the spec's table | No new packages, icons or services. Glyphs stay text (`✓`, `⚠`), as in M3 | $0 |

## 1. Jobs and rules

| Who | New job | The one next step on screen |
|---|---|---|
| Person who owes, proportional bill still being claimed | "I've claimed my stuff; let me pay and leave the table." | **Pay Hana $15.10 on Venmo** (as M3 3.1), with the "may change" line |
| Person whose share went up after paying | "Pay the extra and be done." | **Pay Hana $1.10 more on Venmo**, then **I paid the difference** |
| Person whose share went down after paying | "Get my money back." | **Request $1.10 from Hana on Venmo** (a nudge; Hana records it) |
| Payer who owes someone back | "Send it back and mark it." | Row controls **Pay $1.10 back**, **I paid it back** |
| Anyone on Home | "Which bills still need me?" | One pill per row |

Rules (M3 rules still apply: one primary at most, only server-confirmed state, no money math in components, no colour-only status, no modals):
- **Whoever owes the money pays it and records it** (SE-4). The other side can only nudge (Request), which never writes.
- **A difference is always shown as the amount to act on now** ($1.10), never as two totals the person has to subtract.
- **Nothing to act on means no button.** Before the bill is complete, a changed share is information only (SE-6), in muted text.
- **±1¢ is never shown as a difference** (SE-11). The screen looks exactly as if the amounts matched.

## 2. What changes where

No new screens or routes. Files are the spec's Tasks 6–9: `lib/settleView.ts` (every string below), `lib/homeMarkers.ts` (pills), `components/SettleCard.tsx`, `components/SettlePeopleList.tsx`, `components/SettleFooter.tsx`, `app/(app)/bills/[id]/settle.tsx`, `app/(app)/index.tsx`. The Settle screen shell (M3 §2) is unchanged: back, title, payer line + Change, banner slot, card, Everyone.

## 3. SettleCard: new states

Card anatomy is unchanged (M3 §3): label, display amount, status lines, primary (block), notes, ghost secondaries. The label/amount slot never moves. Every state below has **at most one primary**.

### 3.A Early (proportional, not complete)

#### A1. Owes, can settle, not marked (spec D6 row 1)
```
┌──────────────────────────────────────┐
│ You owe Hana                         │  label
│ $15.10                               │  display
│ Your share may change until          │  muted caption, not live
│ everything is claimed (1 item left). │
│                                      │
│ [   Pay Hana $15.10 on Venmo     ]   │  primary, block
│ @hana-1 · $15.10                     │  note, muted
│ On a computer? Send it from the      │  note, web only
│ Venmo app on your phone.             │
│                                      │
│ I already paid                       │  ghost
└──────────────────────────────────────┘
```
- The "may change" line sits **above** the button, so it's read before paying. Count from `leftToClaim`: "1 item left", "2 items left", "1 discount left", "2 items and 1 discount left".
- After Pay: M3 3.2 ("Did you pay Hana?" / $15.10 / **I paid** / notes / "Open Venmo again"), plus the same "may change" line.
- Payer has no Venmo: M3 3.5 plus the "may change" line, between the label block and **I paid**.

#### A2. Owes, cannot settle yet (no item claimed; spec E2/E3)
```
┌──────────────────────────────────────┐
│ Not ready yet                        │
│ Claim what you had on the bill, then │  muted
│ come back to pay.                    │
│ [        Back to the bill        ]   │  primary → dismissTo
└──────────────────────────────────────┘
```
No amount (it would read $0.00 and look final).

#### A3. Nothing / negative, early
M3 3.6 ("You're all set" / "You don't owe anything on this bill.") or 3.7 ("Hana owes you" / "$1.00" / "Settle that outside the app."), plus the "may change" line as the last line. No buttons. The 3.6 case is E4 (only a $0.00 item claimed); the button is hidden as the spec says.

#### A4. Marked early, no change (SE-UX-1)
```
┌──────────────────────────────────────┐
│ You paid Hana                        │
│ $15.10                               │
│ ✓ Marked paid                        │  success, live (polite)
│ If your share changes, you'll settle │  muted
│ the difference here once everything  │
│ is claimed.                          │
│                                      │
│ Undo                                 │  ghost, no confirm
└──────────────────────────────────────┘
```
Why not the spec's "may change … (1 item left)" here: the person has already paid. What they need to know is what happens next, not a warning.

#### A5. Marked early, share has moved (`pending`; SE-UX-2)
```
┌──────────────────────────────────────┐
│ You paid Hana                        │
│ $15.10                               │
│ ✓ Marked paid                        │  success
│ Your share is now $16.20. You'll pay │  muted, no ⚠
│ the $1.10 difference once everything │
│ is claimed.                          │
│                                      │
│ Undo                                 │  ghost
└──────────────────────────────────────┘
```
- Down: `Your share is now $14.00. Hana will owe you $1.10 back once everything is claimed.`
- Down to $0 or below: `Your share is now $0.00. Hana will owe you $15.10 back once everything is claimed.` The amount is capped at the mark (SE-12), so for −$1.00 it is still $15.10.
- Muted, not warning: there's nothing to do yet, and warning colour on a card that also says "✓ Marked paid" reads like an error. The words carry the meaning.
- Spec D6 gives one sentence for both directions ("Settle the difference once everything is claimed."). This brief says which way and how much, so `pending` needs `kind` and `cents` from `lib/settle.ts` (changes the spec, §9).

#### A6. Payer, early
```
┌──────────────────────────────────────┐
│ Waiting for everyone to claim        │  label, no amount
│ 1 item left to claim                 │  muted
│ 1 paid so far                        │  muted, live (polite); hidden at 0
└──────────────────────────────────────┘
```
- No Request buttons (SE-8). The "Add your Venmo" card (M3 3.8) shows above this card in early mode too, once anyone has an item claim (SE-UX-17). People can pay early, so the payer needs a username now. That's the screen's one primary (tonal, VP-M2).
- `1 paid so far` / `2 paid so far` (the number is people with a mark).

### 3.B Ready, with a difference (spec D6 table)

#### B1. `more_due`: share went up
```
┌──────────────────────────────────────┐
│ You owe Hana more                    │
│ $1.10                                │  display: the difference
│ Your share is now $16.20. You've     │  muted
│ marked $15.10 paid.                  │
│                                      │
│ [ Pay Hana $1.10 more on Venmo   ]   │  primary, block
│ @hana-1 · $1.10                      │  note
│ On a computer? Send it from the      │  note, web only
│ Venmo app on your phone.             │
│                                      │
│ I paid the difference   Undo "I paid"│  ghost, ghost
└──────────────────────────────────────┘
```
- Mark 0 (paid back earlier, share up again, spec D7): line `Your share is now $5.00.`
- **Undo is relabelled `Undo "I paid"`** on difference cards (SE-UX-3). Next to "I paid the difference", a bare "Undo" reads as "undo the difference", but it clears the whole $15.10 mark.

#### B2. `more_opened`: after tapping Pay more
```
┌──────────────────────────────────────┐
│ Did you pay Hana $1.10?              │
│ $1.10                                │
│                                      │
│ [     I paid the difference      ]   │  primary
│ @hana-1 · $1.10                      │  note (+ web line)
│ Open Venmo again                     │  ghost
└──────────────────────────────────────┘
```
Same rules as M3 3.2. The tap decides it (no return detection). It's dropped when a refetch shows a different payer, a different mark, or a different difference. While saving, the primary shows loading and the ghost is disabled. "✓ Marked paid" shows only after the refetch has the new mark. Then the card is B7.

#### B3. `more_due`, payer has no Venmo
```
│ You owe Hana more                    │
│ $1.10                                │
│ Your share is now $16.20. You've     │  muted
│ marked $15.10 paid.                  │
│ Hana hasn't added Venmo yet. Ask     │  muted
│ them, or pay another way.            │
│ [     I paid the difference      ]   │  primary
│ Undo "I paid"                        │  ghost
```

#### B4. `back_due`: share went down (person's view)
```
┌──────────────────────────────────────┐
│ Hana owes you                        │
│ $1.10                                │
│ Your share is now $14.00. You've     │  muted
│ marked $15.10 paid.                  │
│                                      │
│ [Request $1.10 from Hana on Venmo]   │  primary; opens Venmo, never writes
│ @hana-1 · $1.10                      │  note
│ On a computer? Send requests from    │  note, web only (existing string)
│ the Venmo app on your phone.         │
│                                      │
│ Undo "I paid"                        │  ghost
└──────────────────────────────────────┘
```
- After Request: **nothing changes on screen** (VR-6). The card stays B4 until Hana records the pay-back. There's no "Requested" label: the app can't know the request was sent.
- No "Hana paid me back" button for Sam (SE-4, SE-5): Hana records what she sent.
- Payer has no Venmo: no button. Lines: `Your share is now $14.00. You've marked $15.10 paid.` + `Ask Hana to pay you back.` Then ghost `Undo "I paid"`.
- **Share below $0** (spec D4, SE-UX-7): the amount is $15.10 (capped at the mark). The lines read `Your share is now -$1.00. You've marked $15.10 paid.` + `Hana also owes you $1.00 for your share. Settle that outside the app.` Without the second line, the person would see "-$1.00" and not know where that dollar goes.

#### B5. `paid_back`: Hana paid back to $0
```
┌──────────────────────────────────────┐
│ You're all set                       │
│ You don't owe anything on this bill. │  muted
│ ✓ Hana paid you back.                │  success, live (polite)
└──────────────────────────────────────┘
```
- Negative share (D4 after pay-back): M3 3.7, "Hana owes you" / "$1.00" / "Settle that outside the app." + `✓ Hana paid you back.`
- No Undo on a $0 mark, as the spec says (SE-UX-16).

#### B6. ±1¢ (never prompted)
Mark $15.10, share $15.11 or $15.09: the plain M3 3.3 card ("You paid Hana" / **$15.10** / "✓ Marked paid" / Undo). No warning, no sub-line, no difference anywhere (card, row, footer, Home). The row shows the share ($15.11) with `✓ Paid`. The payer's card counts Sam as paid. Within tolerance, the screen looks exactly as if the amounts matched.

#### B7. After a difference is recorded
M3 3.3 with the **net** amount (SE-UX-15): after paying more, "You paid Hana / $16.20 / ✓ Marked paid". After a pay-back, "You paid Hana / $14.00 / ✓ Marked paid". The steps are in Activity ("You paid Hana $1.10 more", "Hana paid you back $1.10"). There's no history line on the card: one number, and it matches what the payer sees.

### 3.C Payer's card, ready, with differences
```
┌──────────────────────────────────────┐
│ 3 people owe you                     │
│ $45.20                               │
│ 3 of 3 paid                          │  muted, live
│ ⚠ 1 difference to settle             │  warning, live; "2 differences to settle"
└──────────────────────────────────────┘
```
- Shown only while every ower is marked and at least one difference remains, as the spec says. While someone is still unmarked, "1 of 3 paid" alone tells the story. The rows show the differences either way.
- Within tolerance: "Everyone's paid" / `✓ All 3 marked paid` (or `✓ They marked paid` for 1).

### 3.D Payer change while a difference is open
No new UI. `set_payer` clears every mark, including $0 ones, so differences vanish with them (spec D9).
```
Dee paid the bill                Change
┌ ⚠ Dee is now collecting for this bill. ┐  warning banner, alert
│   If you already paid Hana, sort it    │
│   out with them.          Dismiss      │
└────────────────────────────────────────┘
┌──────────────────────────────────────┐
│ You owe Dee                          │  M3 3.1, the full share
│ $16.20                               │
│ [    Pay Dee $16.20 on Venmo     ]   │
│ …                                    │
```
- A `more_opened` prompt for Hana is dropped on that refetch. No control can record a difference to the old payer.
- The host's confirm counts every mark, $0 included: `Switch to Dee? This clears 2 "I paid" marks (Sam, Ana).`

### 3.E Blocked states that remain
| State | Card |
|---|---|
| Even mode, not complete (SE-UX-8) | "Not ready yet" / `You can settle up once every item is claimed (3 items left).` (unchanged string) + new muted line `Tax and tip are split evenly on this bill, so shares aren't set until then.` + `Your "I paid" is saved.` when marked (E13). Primary "Back to the bill". No amount |
| Early, no item claim | A2 above |
| All-$0 (rule Z, now complete **or** not) | M3 3.10 unchanged: host "Edit items" + ghost "Back to the bill"; guest "Back to the bill". Plus `Your "I paid" is saved.` when marked |
| Bad payer | M3 3.11 unchanged |

Why the even-mode line: with early settling, one bill lets you pay now and the next doesn't. One sentence says why, so it doesn't look like a bug.

### 3.F Errors (additions to M3 3.12)
| Cause | Copy | Then |
|---|---|---|
| `mark_changed` | `Your "I paid" just changed. Check the amount and try again.` (spec) | refetch |
| `all_zero` | `SETTLE_COPY.invalidBill` ("Couldn't save. Refresh and try again.") | refetch |
| `not_complete` on the Settle screen (SE-UX-13) | `Something on the bill just changed. Check your share and try again.` (settle-only copy; `BILL_ERROR_COPY.not_complete` is untouched) | refetch |
| Opening Venmo failed, pay more | `Couldn't open Venmo. Send $1.10 to @hana-1 in the Venmo app.` (existing `openFailedText`) | still go to B2 |
| Opening Venmo failed, request (card or row) | `Couldn't open Venmo. Request $1.10 from @hana-1 in the Venmo app.` (existing) | none |
| Opening Venmo failed, pay back (row) | `Couldn't open Venmo. Send $1.10 to @sam-1 in the Venmo app.` | none |

Why the new `not_complete` copy: early marks fail with it when the host switched to even or the person unclaimed everything. The existing "Some items aren't claimed anymore" would be wrong in both cases.

## 4. Everyone list changes

Order, aside and the "nothing listed" rule are unchanged (M3 §4). In early mode: rows for people with an item claim or a mark, no aside, no controls. Pending rows keep today's sub-line `Marked $15.10 · share now $16.20 ⚠`.

### 4.1 Payer's view, ready (Hana)
```
┌ Everyone ───────────────────────────────┐
│ Sam            $16.20   Owes $1.10 more │  status muted
│   Marked $15.10 · share now $16.20      │  sub-line muted
│   @sam-1                 Request $1.10  │  control line: handle left, ghost right
│─────────────────────────────────────────│
│ Ana            $14.00  You owe $1.10    │  status WARNING (the payer must act)
│                                  back   │  (wraps at narrow widths)
│   Marked $15.10 · share now $14.00      │
│   @ana-1                Pay $1.10 back  │  ghost; opens Venmo
│                         I paid it back  │  ghost; records it
│─────────────────────────────────────────│
│ Dee            $20.00         ✓ Paid    │
│                                  Undo   │
│─────────────────────────────────────────│
│ Raj             $0.00     ✓ Paid back   │  success
│─────────────────────────────────────────│
│ Kim            $12.00         Not yet   │
│   @kim-1                       Request  │  unchanged (VR)
└─────────────────────────────────────────┘
  On a computer? Open Venmo on your phone   ← web only (SE-UX-11)
  to pay or request.
```
- **Control line** (SE-UX-5): the same spot and style as today's Request and Undo (VR-P1). The handle is on the left, controls flush right. "I paid it back" goes on its own line under "Pay $1.10 back", so two ghost buttons never sit side by side on a phone. The handle is hidden from screen readers, because the button labels end with it (VR-P2).
- **No Undo for the payer on a row with an open difference** (SE-UX-4). The difference controls take Undo's place. Undo comes back once the difference is settled. The host who isn't the payer keeps Undo on every marked row (they have no difference controls). Why: three controls on one row is clutter, and Undo there erases what Sam already paid, which is almost never what the payer means.
- **Sub-line on ready difference rows has no `⚠`.** The status words already say it. It stays muted so the row has one emphasis point.
- **Status tone**: `You owe $X back` is warning, because the payer has to act. `Owes $X more` is muted (Sam acts; Request is optional). `✓ Paid back` is success.
- Payer's own Venmo missing: the controls still show (the Venmo account on the phone is what sends). Sam or Ana with no valid username: `Pay $1.10 back` is replaced by the caption `Hasn't added Venmo`; `I paid it back` stays (cash works). The more-due row shows only the caption.
- Over the link cap: the caption `Request it in the Venmo app` (existing) or `Pay it back in the Venmo app` (new, same rule).
- After **I paid it back**: the button shows loading, then the refetch shows `✓ Paid` and the normal row (with Undo again).

### 4.2 Everyone else's view (Dee as host, or another ower)
```
│ Sam            $16.20   Owes $1.10 more │
│   Marked $15.10 · share now $16.20      │
│                                  Undo   │  host only, inline confirm (M3-UX-3)
│ Ana            $14.00   Hana owes $1.10 │
│                                  back   │
│   Marked $15.10 · share now $14.00      │
│ Raj             $0.00     ✓ Paid back   │
```
No difference controls (SE-4, SE-5).

### 4.3 The viewer's own row (SE-UX-6)
The viewer's row reads as "You", so the status uses the second person: `You owe $1.10 more` on Sam's own row, `Hana owes you $1.10 back` on his own back-due row, `✓ Paid back` after. No controls on your own row; they live on your card (one home per action).

## 5. Bill-screen footer

| State (server plan, viewer) | Footer | Caption | Change |
|---|---|---|---|
| < 2 people | none | | unchanged |
| Early, viewer can settle, unmarked | **primary** "Settle up" | `You can pay now · 1 item left to claim` | spec D6 |
| Early, viewer marked (SE-UX-9) | secondary "Settle up" | `✓ Marked paid · 1 item left to claim` | new |
| Early, cannot settle; even mode not complete | secondary "Settle up" | `3 items left to claim` | unchanged |
| Ready, owes | Pay footer (VR F-c / F-d) | | unchanged |
| Ready, marked, no difference | primary "Settle up" | `✓ Marked paid` | unchanged |
| Ready, `more_due` / `more_opened` (SE-UX-9) | primary "Settle up" | `You owe Hana $1.10 more` | new |
| Ready, `back_due` (SE-UX-9) | primary "Settle up" | `Hana owes you $1.10 back` | new |
| Payer, ready, differences remain (SE-UX-9) | primary "Settle up" | `1 difference to settle` / `2 differences to settle` | new |
| Everything else | as today | | unchanged |

- "Settle up" is the label in every row. Early paying is announced by the caption, not a new label ("Pay now" would promise a Pay screen and then show a card with a warning line).
- Difference payments stay on Settle up (SE-9). The footer caption makes them findable without a second Pay path.
- Captions with counts refresh from the screen's optimistic counts, as the spec's `early` flag does. Only exactly `✓ Marked paid` is a live region. The early-marked caption isn't, because it would speak on every claim tap. iOS announces the mark itself (§7).
- a11y hint: early unmarked `You can pay your share now. 1 item left to claim`; difference states `See the difference and settle it`.

## 6. Home row markers

### 6.1 Priority (one marker per row, first match wins)
1. **New** (unchanged).
2. **Nothing claimed yet** (unchanged).
3. Settle marker, when settle data for that bill is loaded:

| # | Viewer | Pill | Tone |
|---|---|---|---|
| H1 | owes, not marked (ready or early) | `You owe $15.10` | **accent** (SE-UX-10; spec says neutral) |
| H2 | owes, marked, no difference (early `pending` included) | `✓ Paid $15.10` | success |
| H3 | owes, `more_due` / `more_opened` | `Paid · $1.10 more to pay` | warning |
| H4 | owes, `back_due` | `Paid · $1.10 back to you` | muted |
| H5 | payer, ready, someone unmarked | `1 person left to pay` / `2 people left to pay` | muted |
| H6 | payer, ready, all marked, differences remain | `1 difference to settle` / `2 differences to settle` | warning |
| H7 | payer, ready, all paid, no differences | `✓ Settled up` | success |
| — | anything else (nothing owed, negative, paid back, blocked, all-$0, payer while early, payer owed by nobody) | none | |
4. No marker.

Tones for the visual designer: **accent** = `primarySurface` / `primary` (as "New"). **muted** = `surfaceMuted` / `textMuted` (as "Nothing claimed yet"). **success** = `successSurface` / `success`. **warning** = `warningSurface` / `warning`. All four pairs are existing tokens; the designer computes contrast for the two new pill pairs (success and warning) in light and dark.

Why accent for H1: "You owe" is the one pill that asks the viewer to do something, like "New". Muted would put it next to "2 people left to pay", where the viewer only waits.

### 6.2 Home list, mixed rows
```
┌ Your bills ─────────────────────────────┐
│ Ana's bill · Nov 25 · $38.00          › │
│ (New)                                   │  accent
│─────────────────────────────────────────│
│ Raj's bill · Nov 24 · $52.40          › │
│ (Nothing claimed yet)                   │  muted
│─────────────────────────────────────────│
│ Hana's bill · Nov 23 · $44.80         › │
│ (You owe $15.10)                        │  accent
│─────────────────────────────────────────│
│ Dee's bill · Nov 22 · $61.00          › │
│ (✓ Paid $20.00)                         │  success
│─────────────────────────────────────────│
│ Hana's bill · Nov 20 · $44.80         › │
│ (Paid · $1.10 more to pay)              │  warning
│─────────────────────────────────────────│
│ Dee's bill · Nov 19 · $30.00          › │
│ (Paid · $1.10 back to you)              │  muted
│─────────────────────────────────────────│
│ Your bill · Nov 18 · $62.00           › │
│ (2 people left to pay)                  │  muted
│─────────────────────────────────────────│
│ Your bill · Nov 15 · $48.00           › │
│ (1 difference to settle)                │  warning
│─────────────────────────────────────────│
│ Your bill · Nov 12 · $90.00           › │
│ (✓ Settled up)                          │  success
│─────────────────────────────────────────│
│ Your bill · Nov 10 · $12.00           › │  no pill: still being claimed (HM-4)
└─────────────────────────────────────────┘
```
- The pill sits under the row label, as today. It never truncates; at large text sizes it wraps inside the pill.
- **Loading (SE-UX-14):** the list shows as soon as `listMyBills` lands. Settle pills appear when `fetchSettleData` lands. On a later refresh (focus, foreground), each row **keeps its previous settle pill until the new settle data lands**, so pills don't blink off and on every time you come back to Home. If the new settle read fails, settle pills are removed (HM-5: a missing pill is harmless, a wrong one isn't). "New" and "Nothing claimed yet" always follow the latest `my_bills`.

### 6.3 Row labels for screen readers
The row is one link. Its label is `<billListLabel>. <marker a11y>`, and the pill isn't read separately:

| Pill | Row label example |
|---|---|
| You owe $15.10 | `Hana's bill · Nov 23 · $44.80. You owe $15.10` |
| ✓ Paid $20.00 | `Dee's bill · Nov 22 · $61.00. Paid $20.00` |
| Paid · $1.10 more to pay | `… Paid, you owe $1.10 more` |
| Paid · $1.10 back to you | `… Paid, Hana owes you $1.10 back` |
| 1 person left to pay | `Your bill · Nov 18 · $62.00. 1 person still has to pay you` |
| 2 differences to settle | `… 2 differences to settle` |
| ✓ Settled up | `… Settled up, everyone has paid you` |

`✓` is never read (glyph `accessible={false}`, or stripped with `withoutGlyph`). Every pill has words, so tone is never the only signal.

## 7. Accessibility

### 7.1 Labels and hints (new controls)
| Control | `accessibilityLabel` | `accessibilityHint` |
|---|---|---|
| Pay more (card) | `Pay Hana $1.10 more on Venmo, to @hana-1` | `Opens Venmo` |
| I paid the difference | `I paid the difference` | `Marks the $1.10 difference as paid` |
| Open Venmo again (B2) | `Open Venmo again` | `Opens Venmo` |
| Request (card, B4) | `Request $1.10 from Hana on Venmo, @hana-1` | `Opens Venmo` |
| Undo "I paid" (difference cards) | `Undo your I paid` | `Clears your whole I paid of $15.10` |
| Request more (row) | `Request $1.10 more from Sam on Venmo, @sam-1` | `Opens Venmo` |
| Pay back (row) | `Pay Ana $1.10 back on Venmo, to @ana-1` | `Opens Venmo` |
| I paid it back (row) | `Mark that you paid Ana $1.10 back` | `Changes Ana's I paid to $14.00` |
| Settle up (footer, early) | `Settle up` | `You can pay your share now. 1 item left to claim` |

Row labels (everything the row shows, in reading order):
- payer viewing: `Sam, marked paid $15.10, share is now $16.20, owes $1.10 more`; `Ana, marked paid $15.10, share is now $14.00, you owe Ana $1.10 back`; `Raj, $0.00, paid back`
- others viewing: `Ana, marked paid $15.10, share is now $14.00, Hana owes Ana $1.10 back`
- own row: `You, marked paid $15.10, share is now $16.20, you owe $1.10 more`; `You, marked paid $15.10, share is now $14.00, Hana owes you $1.10 back`
- early pending row: `Sam, marked paid $15.10, share is now $16.20` (unchanged)

### 7.2 Announcements
- `I paid the difference` lands: iOS `announceForAccessibility('Difference marked paid')`. Android and web read the card's "✓ Marked paid" line (already polite).
- `I paid it back` lands: iOS announces `Marked paid back`. Android and web: the Everyone card gets a polite caption slot (same pattern as the card's `announcement`) that shows `Marked paid back` until the next action (SE-UX-12).
- B5's `✓ Hana paid you back.` is a polite live line, so Sam hears it when it arrives live.
- Live regions on payer lines: `1 paid so far`, `3 of 3 paid` and `1 difference to settle`. The "may change" and pending lines are not live, because they would talk on every claim.
- Opening Venmo (pay, pay more, request, pay back) announces nothing. Errors use `Banner alert`.
- Focus after Pay more swaps the card to B2: acceptable on the card label (as M3).

### 7.3 Copy at a count of 1 and with "You"
| Template | Count 1 | Count 2 | With "You" |
|---|---|---|---|
| may change | `(1 item left)` | `(2 items left)`; `(2 items and 1 discount left)` | n/a (always the viewer) |
| payer early | `1 item left to claim`, `1 paid so far` | `2 items left to claim`, `2 paid so far` | label has no name |
| payer differences | `1 difference to settle` | `2 differences to settle` | n/a |
| Home H5 | `1 person left to pay` | `2 people left to pay` | the pill never names the viewer |
| Home H6 | `1 difference to settle` | `2 differences to settle` | |
| row status, others viewing a back-due row | | | payer is the viewer → `You owe $1.10 back` (never "You owes"); the row is the viewer's → `Hana owes you $1.10 back` |
| row status, more due | | | own row → `You owe $1.10 more` (never "You owes") |
| `<Payer> owes you` (card) | | | can't be the viewer (the payer has no ower card) |
| Activity (spec D8) | | | `You paid Hana $1.10 more`, `Hana paid you back $1.10`, `You paid Sam back $1.10` |
| Payer-change banner | | | new payer is the viewer → `You're now collecting for this bill.` (existing) |

### 7.4 Never colour alone
Pills and statuses all carry words. `✓` only goes with "Paid", "Paid back" or "Settled up". `⚠` stays only on the payer's "difference to settle" line and early pending rows. The warning tone always comes with "more to pay", "to settle" or "owe … back".

## 8. Web and desktop (Venmo links)

- **Same buttons on every platform** (M3 Q8, VR-9). The browser has no way to know whether a Venmo app is reachable. Hiding the buttons on web would leave a desktop user with less information.
- **Open first, no await before it.** Every pay, pay-more, request and pay-back handler calls `openPaymentLink(url)` as its first statement, inside the tap, so popup blockers allow it. A 1 s repeat-tap guard applies: one guard for card links and one for list links (VR-P3).
- **The handle line is the fallback.** A blocked popup can't be detected, so `@hana-1 · $1.10` stays visible under every card link. On rows, `@sam-1` is shown left of the control.
- **Web lines (SE-UX-11):**
  - Card, pay or pay more: `On a computer? Send it from the Venmo app on your phone.` (existing)
  - Card, request (B4): `On a computer? Send requests from the Venmo app on your phone.` (existing string, reused)
  - List, Request links only: the existing request line.
  - List with any Pay-back link: `On a computer? Open Venmo on your phone to pay or request.` (new, one line for both)
- **Desktop venmo.com behaviour is unverified** for both `txn=pay` and `txn=charge` (spec U1, ADR 0007). The copy promises nothing about what the tab shows.
- **After returning to the tab** nothing is detected. The B2 prompt is already on screen. Requests and pay-backs change nothing until someone records them.
- Mouse and keyboard: every new control is a `Button` (focus ring, Tab order: card label → amount → lines → primary → notes → secondaries; rows: row → control line).

## 9. Things in the spec that hurt the experience, and what this brief does instead

| ID | Problem in the spec | Simpler alternative (built here) | Tag |
|---|---|---|---|
| SE-UX-1 | A marked early card repeats "Your share may change … (1 item left)". After paying, that reads as a warning with nothing to do | `If your share changes, you'll settle the difference here once everything is claimed.` | copy/layout only |
| SE-UX-2 | Pending line is warning-coloured with `⚠` and doesn't say which way or how much ("Settle the difference once everything is claimed") | Muted, no glyph, direction and amount: `You'll pay the $1.10 difference …` / `Hana will owe you $1.10 back …`. Needs `pending: { owedCents, kind, cents }` from `lib/settle.ts` (amount capped at the mark, as in contract D) | **changes the spec** (D4/D6 model; criterion 27 text) |
| SE-UX-3 | Bare "Undo" next to "I paid the difference" looks like it undoes the difference | `Undo "I paid"` on B1/B3/B4, hint `Clears your whole I paid of $15.10` | copy/layout only |
| SE-UX-4 | Spec D6 is ambiguous about Undo on difference rows. Payer rows could carry Pay back + I paid it back + Undo | For the **payer**, the difference controls replace Undo until the difference is settled. The host who isn't the payer keeps Undo | **changes the spec** (D6 rows; Q4 for that window) |
| SE-UX-5 | Row layout for the new controls is unstated; today's sub-line keeps `⚠` next to a status that already says it | Control line under the row (handle left, controls right, "I paid it back" on its own line); ready difference sub-line without `⚠`; back-due status in warning tone (payer view) | copy/layout only |
| SE-UX-6 | Status texts for the viewer's own row read "Owes $1.10 more" / "Hana owes $1.10 back" | `You owe $1.10 more` / `Hana owes you $1.10 back` on the viewer's own row | copy/layout only |
| SE-UX-7 | back_due with a negative share shows "-$1.00" and doesn't say where that dollar goes | Extra line `Hana also owes you $1.00 for your share. Settle that outside the app.` | copy/layout only |
| SE-UX-8 | One bill allows paying early and the next doesn't, with no reason given | Even-mode blocked card adds `Tax and tip are split evenly on this bill, so shares aren't set until then.` (needs the bill's split mode in `SettleViewInput`) | copy/layout only |
| SE-UX-9 | Footer is silent about differences and about an early mark, so a changed share is only visible after opening Settle up | Captions: `✓ Marked paid · N left to claim` (early marked, secondary), `You owe Hana $1.10 more`, `Hana owes you $1.10 back`, `N difference(s) to settle` (primary). Still no Pay in the footer (SE-9 kept) | **changes the spec** (D6 "everything else unchanged"; criteria 34/43 gain cases) |
| SE-UX-10 | H1 "You owe" is neutral, the same weight as rows where the viewer only waits | H1 accent; H4 and H5 muted | copy/layout only |
| SE-UX-11 | No web line for the payer's Pay-back links | `On a computer? Open Venmo on your phone to pay or request.` when the list has a pay-back link | copy/layout only |
| SE-UX-12 | No announcement for "I paid it back" (the list has no live slot) | iOS `Marked paid back` / `Difference marked paid`; a polite caption slot on the Everyone card | copy/layout only |
| SE-UX-13 | `not_complete` after an early mark fails shows "Some items aren't claimed anymore", which is wrong when the host switched to even or you unclaimed | Settle-only copy `Something on the bill just changed. Check your share and try again.` | copy/layout only |
| SE-UX-14 | Home pills would blink off and on at every focus/foreground refresh (list lands first, settle data second) | Keep each row's previous settle pill until the new settle data lands; drop them if that read fails | **changes the spec** (D7/Task 9 refresh behaviour; criterion 44 gains a case) |
| SE-UX-15 | (Kept) after a difference, the marked card shows one net number | Net amount, no history line; Activity has the steps | copy/layout only (confirms spec) |
| SE-UX-16 | (Kept) no Undo on a $0 mark. Side effect: the $0 mark blocks leaving (SE-13), and `cannot_leave` copy says only "Unclaim your items first." | No change in this slice; noted for the leave-copy owner | copy/layout only (confirms spec; risk noted) |
| SE-UX-17 | `addVenmoPrompt` only shows on a ready plan, so in early mode a payer without Venmo isn't asked, while owers are already being shown "Hana hasn't added Venmo yet" | Show the "Add your Venmo" card to the payer in an early plan too, once anyone has an item claim (A6) | **changes the spec** (D6 payer row; one condition in `addVenmoPrompt`) |

## 10. Copy reference (new or changed keys, `lib/settleView.ts` / `lib/homeMarkers.ts`)

| Key | Copy |
|---|---|
| mayChange | `Your share may change until everything is claimed (<n> left).` |
| earlyMarkedLine | `If your share changes, you'll settle the difference here once everything is claimed.` |
| pendingMore / pendingBack | `Your share is now $Y. You'll pay the $D difference once everything is claimed.` / `Your share is now $Y. <Payer> will owe you $D back once everything is claimed.` |
| earlyNoClaim | label `Not ready yet`, body `Claim what you had on the bill, then come back to pay.` |
| payerEarlyLabel / leftLine / paidSoFar | `Waiting for everyone to claim` / `<n> left to claim` / `<p> paid so far` |
| moreLabel / moreButton / moreOpened / markDifference | `You owe <Payer> more` / `Pay <Payer> $D more on Venmo` / `Did you pay <Payer> $D?` / `I paid the difference` |
| diffLine | `Your share is now $Y. You've marked $X paid.` (mark 0: `Your share is now $Y.`) |
| backLabel / requestButton / backNoVenmo | `<Payer> owes you` / `Request $D from <Payer> on Venmo` / `Ask <Payer> to pay you back.` |
| backNegativeLine | `<Payer> also owes you $N for your share. Settle that outside the app.` |
| paidBackLine | `✓ <Payer> paid you back.` |
| undoMark | `Undo "I paid"` |
| payerDiffLine | `⚠ 1 difference to settle` / `⚠ <d> differences to settle` |
| evenBlockedLine | `Tax and tip are split evenly on this bill, so shares aren't set until then.` |
| rowMore / rowMoreOwn | `Owes $D more` / `You owe $D more` |
| rowBackPayer / rowBackOthers / rowBackOwn | `You owe $D back` / `<Payer> owes $D back` / `<Payer> owes you $D back` |
| rowPaidBack | `✓ Paid back` |
| rowSubLine (ready difference) | `Marked $X · share now $Y` |
| rowRequestMore / rowPayBack / rowPaidItBack | `Request $D` / `Pay $D back` / `I paid it back` |
| payBackTooLarge | `Pay it back in the Venmo app` |
| listVenmoWebLine | `On a computer? Open Venmo on your phone to pay or request.` |
| notCompleteSettle | `Something on the bill just changed. Check your share and try again.` |
| payBackOpenFailed | `Couldn't open Venmo. Send $D to @handle in the Venmo app.` (existing `openFailedText`) |
| footerEarly / footerEarlyMarked | `You can pay now · <n> left to claim` / `✓ Marked paid · <n> left to claim` |
| footerMore / footerBack / footerPayerDiffs | `You owe <Payer> $D more` / `<Payer> owes you $D back` / `<d> difference(s) to settle` |
| announce | `Difference marked paid` / `Marked paid back` |
| Home pills | `You owe $X` · `✓ Paid $X` · `Paid · $D more to pay` · `Paid · $D back to you` · `1 person left to pay` / `<n> people left to pay` · `1 difference to settle` / `<n> differences to settle` · `✓ Settled up` |

Existing tests that assert strings this brief changes (for Task 6/8 to update, found by grep 2026-11-25): the ⚠ sub-line on ready rows (`lib/settleView.test.ts` share-changed expectations the spec already lists at `:187-205`, `:401`, `:409`, `:666-669`, `:974`; `__tests__/settle.test.tsx:835-861`). The `blockedBody` strings at `lib/settleView.test.ts:290-309` and `__tests__/settle.test.tsx:472,493` are **not** changed by SE-UX-8 (it adds a separate line). The proportional fixtures in those screen tests will become early plans anyway under the spec, so Task 8 checks them.

## 11. Notes for the visual designer and the staff engineer

- **Visual:** new pill tones (success, warning) on Home need contrast checks in both themes. The back-due row's warning status may wrap to two lines at default size with long names, so check the 375-pt layout. The B1 primary label ("Pay Hana Lee-Watanabe $1.10 more on Venmo") wraps; the button must grow, not truncate.
- **Engineering, as model changes this brief adds:** `pending.kind` and `pending.cents` (SE-UX-2); the bill's split mode on `SettleViewInput` (SE-UX-8); footer captions for difference states and early-marked (SE-UX-9); a `payBack` row control with its own caption/too-large variants (SE-UX-5); Home keeping the previous settle map during a refresh (SE-UX-14); `addVenmoPrompt` in early plans (SE-UX-17). Components still do no money math: every amount above comes from `lib/settle.ts` through `lib/settleView.ts` / `lib/homeMarkers.ts`.
