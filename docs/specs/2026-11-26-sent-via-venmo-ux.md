# Sent via Venmo and choosing how you paid: UX brief (screens, copy, notification)

Date: 2026-11-26. Companion to `docs/specs/2026-11-26-sent-via-venmo.md` (the "spec"). The spec owns data, contracts (M, A, C, N, S, V), money rules and the DB. This brief owns layout, states, copy, tone and accessibility. It extends the settle-early brief `docs/specs/2026-11-25-settle-early-and-differences-ux.md` (section numbers like "B1" refer to it) and keeps its rules and the visual pass's rules: no `✓`/`⚠` in any copy string (VP-30; the UI draws the icon from `tone`), icons follow tone, secondary buttons are tonal, and Home pills have two tones (accent, muted) and no check icon (SE-VIS-1, Q-GLYPH).

The user asked for a design that is "seamless and nice, a positive experience, not too much work, but also reliable, easy to see, understand and follow". They approved building straight through, so this goes to the visual designer and the staff engineer next. Every choice is decided here and logged as **SV-UX-1 … SV-UX-22** in `docs/decisions-to-review.md` ("2026-11-26 · Sent via Venmo, UX brief"). §11 lists which ones change the spec.

What I read first: the spec; the settle-early brief; `lib/settleView.ts`; `components/SettleCard.tsx`, `SettlePeopleList.tsx`, `SettleFooter.tsx`; `app/(app)/bills/[id]/settle.tsx`; `app/(app)/index.tsx`, `lib/homeSections.ts` (splitit-app-96's "Waiting on you" / "Recent"); `lib/homeMarkers.ts`; `docs/learning/concepts/design-system.md` (VP-30, `SegmentedControl`, tonal `secondary`); `.claude/skills/ui-ux-designer/SKILL.md`; the `[area: expo]` lessons (count of 1 and "You", one home per action, key prompts on the facts that make them true, one status source per screen).

Worked example: **Hana** pays the bill (`@hana-1`). **Sam** owes $15.10 (`@sam-1`). **Dee** is the host when the host isn't the payer.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| None beyond the spec's table | No new packages, icons or services. `SegmentedControl`, `ToneIcon`, `Banner`, `Button` (tonal `secondary`, `ghost`, `danger`) already exist | $0 |
| `expo-notifications` (spec, Task 1) | One more option to verify: the iOS category's hidden-preview placeholder and a silent sound setting (SV-UX-6) | $0; verify in Task 1 |

## 1. Jobs and rules

| Who | Job | The one next step on screen |
|---|---|---|
| Sam, owes, has Venmo | "Pay and be done, without coming back to tap anything." | **Pay Hana $15.10 on Venmo** (one tap; the record writes itself) |
| Sam, paid in cash | "Tell the app I handed Hana cash." | **I paid Hana $15.10 in cash** |
| Sam, paid with Zelle or something else | "Record it truthfully." | the quiet link **Paid another way** |
| Sam, back from Venmo | "Did that work?" | **Yes** / **No, undo** (one muted line, once) |
| Sam, after Hana says it never arrived | "What happened, and how do I fix it?" | warning line + the normal Pay card |
| Hana, the payer | "Who's paid me, and how?" | rows read "Sent via Venmo" / "Paid in cash"; **Not received** if it didn't arrive |
| Hana, on Home | "Did anyone pay me?" | the pill **Sam sent you $15.10** under Recent |

Rules (the M3 and settle-early rules still apply: one primary at most, only server-confirmed state, no money math in components, no colour-only status, no modals):
- **Say only what the app knows.** Opening Venmo is "Sent". A self-report is "Paid" (cash) or "Marked paid" (other). Counts and totals across people say "settled up", the app's own status word, never "paid" (SV-UX-14).
- **One primary, a sensible default, one quiet way out.** The chooser picks which primary you see; nothing else changes.
- **Ask once, never nag.** The check-in question shows once per send (notification or inline, not both). The permission ask happens once per device. Denied means silence.
- **Good news is quiet but warm.** Completion gets a short, friendly line ("You're all set."), not a modal, toast or animation.
- **Bad news is calm and says what to do.** "Hana hasn't received your $15.10. Check Venmo before paying again." No "failed", "error", "warning" or exclamation marks.

## 2. What changes where

No new screens or routes. Files are the spec's Tasks 6, 7 and 9: `lib/settleView.ts` (every Settle string below), `lib/sentCheck.ts` (check-in strings), `lib/paymentMethods.ts` (method words), `lib/homeMarkers.ts` (pills), `components/SettleCard.tsx`, `components/SettlePeopleList.tsx`, `components/SettleFooter.tsx`, `components/SentCheckResponder.tsx`, `app/(app)/bills/[id]/settle.tsx`, `app/(app)/bills/[id]/index.tsx`. The Settle screen shell is unchanged: back, title, payer line + Change, banner slot, card, Everyone.

Card anatomy is unchanged except for one new slot, the **chooser**, between the head lines and the primary:

```
label
display amount
status lines (warning first, then muted)
[ chooser ]                ← new, only on owes / more-due cards with 2 methods
[ primary, block ]
notes (handle, web line, permission line)
inline check (marked venmo cards only)   ← new
ghost secondaries
```

The label/amount slot never moves.

## 3. The owes card: choosing how you pay

### 3.1 Venmo selected (the default when Hana has Venmo)
```
┌──────────────────────────────────────┐
│ You owe Hana                         │  label
│ $15.10                               │  display
│                                      │
│  ┌─────────────┬─────────────┐       │  SegmentedControl, full width
│  │ ▌ Venmo ▐   │    Cash     │       │  radio group "How you're paying"
│  └─────────────┴─────────────┘       │
│                                      │
│ [   Pay Hana $15.10 on Venmo     ]   │  primary, block
│ @hana-1 · $15.10                     │  note, muted
│ We'll check back in a minute to make │  note, muted; native only, only while
│ sure it went through.                │  notification permission is undetermined
│                                      │
│ Paid another way                     │  ghost
└──────────────────────────────────────┘
```
- **No visible label on the chooser** (SV-UX-1). "Venmo | Cash" under "You owe Hana $15.10" explains itself. A heading would add a line to every card for no gain. Screen readers get the group label `How you're paying`.
- **Default** (spec D5): the method remembered on this device, if available; else Venmo if Hana has a valid username; else Cash. Tapping a segment remembers it at once. Next time, the card opens on that choice, so a regular cash payer sees "I paid … in cash" as the primary without touching the chooser.
- **Switching** changes only the primary and its notes. The amount, label and lines stay still, so nothing jumps.
- While any write from the card is in flight, the chooser is disabled with the buttons.
- **"Paid another way"** shows under both choices. It's for Zelle, PayPal, Cash App or anything else. It's never remembered.
- Early plan: the "may change" line (A1) sits in the lines slot, above the chooser, as today.
- Web: the existing note `On a computer? Send it from the Venmo app on your phone.` follows the handle line. Web never shows the permission line.

### 3.2 Cash selected
```
┌──────────────────────────────────────┐
│ You owe Hana                         │
│ $15.10                               │
│  ┌─────────────┬─────────────┐       │
│  │    Venmo    │ ▌ Cash ▐    │       │
│  └─────────────┴─────────────┘       │
│ [  I paid Hana $15.10 in cash    ]   │  primary, block; nothing opens
│                                      │
│ Paid another way                     │  ghost
└──────────────────────────────────────┘
```
No notes: there's no handle to show and nothing opens.

### 3.3 Cash only (Hana has no Venmo; SV-29)
```
┌──────────────────────────────────────┐
│ You owe Hana                         │
│ $15.10                               │
│ Hana hasn't added Venmo yet.         │  muted
│ [  I paid Hana $15.10 in cash    ]   │  primary
│ Paid another way                     │  ghost
└──────────────────────────────────────┘
```
No chooser. A remembered "Venmo" is ignored here and kept for the next bill.

### 3.4 More-due card (share went up after a mark)
Mirrors 3.1/3.2 with the settle-early B1 head:
```
│ You owe Hana more                    │
│ $1.10                                │
│ Your share is now $16.20. You've     │  muted; "You've sent $15.10." for a venmo mark,
│ sent $15.10.                         │  "You've paid $15.10." for cash/other
│  [ ▌ Venmo ▐ |    Cash     ]         │
│ [ Pay Hana $1.10 more on Venmo   ]   │  primary (Cash: "I paid the $1.10 in cash")
│ @hana-1 · $1.10                      │
│ I paid the difference   Undo all $15.10 │  ghost, ghost
```
- `Undo all $15.10` replaces `Undo "I paid"` on every difference card, for every method (SV-UX-18). It says exactly what it clears.
- For a cash or `other` mark, the summary reads `You've paid $15.10.` (today's `You've marked $15.10 paid.` was written for a manual tap; with methods, the plainer verb is accurate: the person said they paid).

## 4. The Venmo send

### 4.1 The tap, step by step

**iOS / Android** (spec D2, write first):

| # | What Sam sees | Notes |
|---|---|---|
| 1 | Taps **Pay Hana $15.10 on Venmo** | |
| 2 | First time on this device only: the iOS/Android "Allow notifications?" system dialog. Our muted line on the card already said why | Whatever he answers, the flow carries on. No second screen |
| 3 | The button shows its spinner (about half a second; at most 4 s) | Chooser and ghosts disabled |
| 4 | Venmo opens with $15.10 to @hana-1 and the note | |
| 5 | Behind Venmo, SplitIt's card is already "You sent Hana" (4.2) | The record is written before he leaves |

**Web** (open first, popup rule): tap → a new Venmo tab opens straight away → the SplitIt tab's card turns into 4.2 as soon as the write lands. If the popup was blocked, see 4.7.

There's no toast or "Sent!" overlay. Sam is in Venmo at that moment, so he wouldn't see it. The confirmation is what he finds when he comes back, and it needs to be calm and obvious (SV-UX-4).

### 4.2 Back in SplitIt: the sent card, with the inline check (spec D3)
```
┌──────────────────────────────────────┐
│ You sent Hana                        │  label
│ $15.10                               │  display
│ [check] Sent via Venmo               │  success, live (polite)
│                                      │
│ Did it go through?                   │  muted
│ Yes          No, undo                │  ghost, ghost (same row, wraps)
└──────────────────────────────────────┘
```
- The label plus amount read as the confirmation: "You sent Hana $15.10". Together with "Sent via Venmo", that's the user's "Sent to Hana · $15.10", said once and in the card's own slots.
- **On the card the question is just `Did it go through?`** (SV-UX-5). The name and amount sit right above it, so repeating them adds a line of wrapping on a phone. The footer and the notification have no such context, so they keep the full `Did your $15.10 to Hana go through?`.
- While the question shows, the card's own Undo is hidden (spec), so there's one undo on screen.
- **Yes**: the question goes away and the completion line takes its slot (4.3). Nothing is written. iOS announces `You're all set`.
- **No, undo**: runs the undo rule (spec D3). While it re-reads and clears, "No, undo" shows its spinner and Yes is disabled. Then the card goes back to 3.1 with the same chooser selection. iOS announces `Undone. Not marked as sent.`. Android and web read the polite announcement slot under the card, which shows that text until the next action.
- **Ignored**: when he navigates away from the screen the question is stored as shown, and it doesn't come back (spec D3). After 30 minutes it doesn't appear at all.
- A **more** send: same card shape (B7 net amount: "You sent Hana / $16.20"), question `Did it go through?`. "No, undo" first shows an inline confirm in the card (warning Banner): `Undo all $16.20? You can only undo the whole amount, not just the $1.10.` with **Undo all** (danger) and **Keep it** (ghost) (SV-UX-18).
- The mark changed since then (undo rule's `changed`): the card shows today's state and an error-slot Banner `Your payment to Hana changed since then, so nothing was undone. Check below.` (SV-UX-19). The question is stored as answered.
- Undo failed (network): Banner `Couldn't undo. Try again.` The question stays, so "No, undo" can be tapped again.

### 4.3 The sent card once the question is gone
```
┌──────────────────────────────────────┐
│ You sent Hana                        │
│ $15.10                               │
│ [check] Sent via Venmo               │  success
│ You're all set. Hana can see it.     │  muted
│                                      │
│ Didn't go through? Undo              │  ghost
└──────────────────────────────────────┘
```
- `You're all set. Hana can see it.` is the completion line (SV-UX-3) on every **ready** marked card with no difference, for every method. It's warm, true (Hana's row shows it), and says nothing else is needed. It isn't a money claim.
- **Early** marked cards keep the settle-early line instead (`If your share changes, you'll settle the difference here once everything is claimed.`). "All set" would be untrue there, because more may be due.
- **Difference** cards (more-due, back-due) never show it.

### 4.4 The check-in notification (native only; spec D3, SV-27)

```
┌ SplitIt ─────────────────────── now ┐
│ Did your $15.10 to Hana go through? │
└─────────────────────────────────────┘
  long-press / pull down:
  [ Yes ]
  [ No, undo ]   (destructive, red)
```

| Field | Value |
|---|---|
| Title | `SplitIt` |
| Body | `Did your $15.10 to Hana go through?` (blank name: `Did your $15.10 go through?`) |
| Actions | `Yes` (doesn't open the app), `No, undo` (destructive; opens Settle up for that bill and runs the undo rule) |
| Tap on the body | Opens Settle up for that bill. The inline question shows there if it still applies |
| Sound | **None** (SV-UX-6). The banner is enough. A chime a minute after paying feels like a nag. Verify the option in Task 1 |
| Hidden-preview text (iOS) | `Check your SplitIt payment`: what iOS shows when the person has set Show Previews to "When Unlocked" or "Never" (SV-UX-6). Verify the category option name in the installed `expo-notifications` (likely `previewPlaceholder`); reword if it differs |
| Never in it | item names, the bill's name, Venmo handles, Sam's own name |
| Badge | none |

**Privacy (SV-27).** The body is the user's own fixed wording (decision 2), shown on Sam's own phone about his own payment. Venmo's own notifications show amounts the same way. The privacy-aware part is honouring the OS setting: anyone who hides previews gets the generic placeholder on the lock screen, with the name and amount only once the phone is unlocked. Nothing about other people's items or the bill leaves the app.

**After the actions:**
- **Yes** (app not opened): nothing visible. If the OS gives the app no chance to store "yes", the inline question may show once on return. That's a harmless repeat, accepted.
- **No, undo**: SplitIt opens on Settle up. The card shows the undo spinner, then 3.1, with the same announcement as 4.2. If it can't undo, the 4.2 error copy applies.
- **Signed out, or another account is signed in**: the tap opens SplitIt and nothing else happens (spec SV-28). No error. The other person's data is never shown.

### 4.5 The permission ask: when and what it says
- **When:** the first Venmo Pay tap on this device (card or footer), before Venmo opens (spec SV-16). Never at launch, never on Home.
- **Pre-prompt:** there's no extra screen. The note under the Pay button, shown only while the permission is undetermined, is the explanation (SV-UX-7):
  `We'll check back in a minute to make sure it went through.`
  It sits under the handle line on the card and in the footer's notes (the footer mirrors the card's notes, so whichever Pay he taps first, he has seen it).
- **The system dialog** is the OS's own text. Our app name is the only thing in it.
- After he answers, the note disappears for good.

### 4.6 Permission denied
Nothing changes visibly: no notification, no note, no "Turn on notifications" link, no re-ask (spec SV-17). The inline question in 4.2 still appears when he comes back, so he loses nothing he needs.

### 4.7 When something goes wrong

| Case | What Sam sees | Copy |
|---|---|---|
| Native: write refused before opening (`payer_changed`, `not_complete`, `mark_changed`…) | Venmo doesn't open. Error Banner in the card; refetch | the existing `actionError` copy (settle-early §3.F) |
| Native: write timed out or no network | Venmo opens anyway. On return, the contract O card (below) | |
| Native: Venmo didn't open after the write | The mark is undone. The card is 3.1 with the open-failed line | `Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.` (SV-UX-17) |
| **Web: popup blocked** (SV-9) | Nothing is recorded. Card stays 3.1 with the open-failed line under the handle (muted, in the notes slot) | same copy as above |
| Web: popup detection unreliable on a browser (spec SV-9 fallback) | Contract O card on return | below |

**Contract O card (the fallback, spec D2):**
```
┌──────────────────────────────────────┐
│ Did you send Hana $15.10?            │  label
│ $15.10                               │
│ [        Yes, I sent it          ]   │  primary; records as venmo
│ @hana-1 · $15.10                     │  note
│ Open Venmo again                     │  ghost; opens only, never writes
└──────────────────────────────────────┘
```
The footer variant adds `Not yet` (ghost), as today.

Why "then tap Paid another way" (SV-UX-17): when Venmo can't open, Sam pays in the Venmo app by hand, and the app can't say "Sent via Venmo" for a send it didn't open. The line tells him the next step instead of leaving him to work it out.

## 5. Cash

```
Tap  [  I paid Hana $15.10 in cash  ]   → spinner (no confirm step)
┌──────────────────────────────────────┐
│ You paid Hana                        │
│ $15.10                               │
│ [check] Paid in cash                 │  success, live (polite)
│ You're all set. Hana can see it.     │  muted (ready, no difference)
│                                      │
│ Undo                                 │  ghost, no confirm
└──────────────────────────────────────┘
```
- One tap, no confirm: Undo is right there (SV-UX-9). Nothing opens, no notification, no inline question.
- iOS announces `Marked paid in cash`. Android/web read the live line.
- **Undo** takes him back to 3.2 with Cash still selected. iOS announces `Marked not paid` (today's string).
- `Paid another way` gives the same card with `Marked paid` and `Undo` (today's 3.3 plus the completion line).

## 6. The payer's view, and Sam after "Not received"

### 6.1 Hana's card
```
┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ 3 people owe you                     │        │ Everyone's settled up. Nice.         │
│ $45.20                               │  then  │ $45.20                               │
│ 1 of 3 settled up                    │  ───▶  │ [check] 2 sent via Venmo · 1 paid in │  success, live
└──────────────────────────────────────┘        │ cash                                 │
                                                └──────────────────────────────────────┘
```
- **"Settled up" for counts, "Nice." for the finish** (SV-UX-14). The user's example was "Everyone's paid. Nice." But two of those three only opened Venmo, and the user's own rule is "never say anything untrue about money". "Settled up" is the app's status word (the Settle up button, Home's "Settled up" pill), so it's true either way. The method line then tells Hana exactly what to check in Venmo.
- Method line: the parts that apply, in the order venmo, cash, other, joined with ` · `: `2 sent via Venmo`, `1 paid in cash`, `1 marked paid`. With one ower it names them: `Sam sent it via Venmo` / `Sam paid in cash` / `Sam marked it paid`.
- Counts while some are open: `1 of 3 settled up`. Payer early: `1 settled up so far`. The non-payer's Everyone aside: `All settled up`.

### 6.2 Hana's rows
```
┌ Everyone ───────────────────────────────┐
│ Sam         $15.10   [check] Sent via   │  status: success tone, icon from tone
│                              Venmo      │  (wraps at narrow widths)
│                           Not received  │  ghost, own line, flush right
│─────────────────────────────────────────│
│ Dee         $20.00 [check] Paid in cash │
│                           Not received  │
│─────────────────────────────────────────│
│ Raj         $10.10          [check] Paid│  ('other')
│                           Not received  │
│─────────────────────────────────────────│
│ Kim            $12.00           Not yet │
│   @kim-1                       Request  │  unchanged
└─────────────────────────────────────────┘
```
- `Not received` takes Undo's spot and style (ghost, own line, flush right, 44-pt target). For the payer it replaces Undo everywhere (spec SV-10). Dee, as host but not payer, keeps `Undo` on these rows.
- Status words come from the method: `Sent via Venmo`, `Paid in cash`, `Paid`. The success tone draws the check icon. No glyph in the strings.

**Confirm** (inline warning Banner inside the row, the existing Undo-confirm pattern; SV-UX-13):
```
│ Sam         $15.10   [check] Sent via Venmo │
│ ┌ [!] Didn't get Sam's $15.10? This     ┐ │  warning Banner
│ │     clears it and lets Sam know.       │ │
│ │  [ Not received ]   Cancel             │ │  danger (tonal red), ghost
│ └────────────────────────────────────────┘ │
```
The copy is the same for every method: it asks the question Hana actually has, and says both effects in plain words.

**After** (the refetch lands):
```
│ Sam            $15.10           Not yet │  muted
│   Not received · $15.10                 │  sub-line, muted
│   @sam-1                       Request  │  (ready plans; unchanged rule)
```
iOS announces `Marked not received. Sam will see it.`. Android/web: the Everyone card's polite caption slot (SE-UX-12) shows the same text until the next action.

### 6.3 Sam after "Not received" (state U!)
```
┌──────────────────────────────────────┐
│ You owe Hana                         │
│ $15.10                               │
│ [!] Hana hasn't received your $15.10.│  warning (first line; icon from tone)
│     Check Venmo before paying again. │
│  [ ▌ Venmo ▐ |    Cash     ]         │
│ [   Pay Hana $15.10 on Venmo     ]   │  the retry: same primary as always
│ @hana-1 · $15.10                     │
│ Paid another way                     │
└──────────────────────────────────────┘
```
- **Where:** the first status line under the amount, not above the label, so the label/amount slot never moves (SV-UX-2).
- **Copy by the cleared method:** venmo `Hana hasn't received your $15.10. Check Venmo before paying again.`; cash `Hana hasn't received your $15.10 in cash.`; other `Hana hasn't received your $15.10.`
- "Before paying again" is the reliability part (SV-UX-2). If Venmo shows the money went, Sam should tell Hana rather than pay twice. If it didn't, the Pay button right below is the retry. The user's wording ("Check Venmo.") left that choice unstated.
- No banner, no "undone" notice (spec SV-19). The line goes away as soon as he records any method.
- **Footer** on the bill screen: secondary-weight info, not a second Pay (SV-UX-11):
  `[ Settle up ]  [!] Hana hasn't received your $15.10`, primary button, warning-tone caption. He gets the full picture on the card before any money moves again.
- **Home:** the pill reads `Not received · $15.10` (accent, under Waiting on you; a11y `Hana hasn't received your $15.10`), not a bare `You owe $15.10` (SV-UX-15). Without it, a bill he thought was done reappears as "You owe" with no reason. This needs the caller's own not-received flag on Home (see §11). *(A1: the flag comes through settle data, not `my_bills()`; the group comes from his balance in Home groups v2, where `MARKER_GROUPS.not_received = ['waiting']` already exists.)*

## 7. Home: Recent items for the payer

> **Superseded 2026-11-26 (spec Amendment A1, D7; Home groups v2, `docs/specs/2026-11-26-home-groups-v2.md`).** There is no "Recent". Home groups come from the viewer's balance: **Waiting on you / Owed to you / Settled / hidden**. The `sent` pill shows on the payer's row in **Owed to you**, only while someone still owes. Once nobody owes, the bill goes straight to **Settled** with `Settled up`; the news is in Activity. A guest who has sent their whole share has the bill **hidden** from Home, so Sam's `Sent $15.10` pill shows only if the bill comes back (e.g. more due). No 72 h age-off. The pill copy in 7.1 stands; the placement and aging in 7.1–7.2 don't.

### 7.1 The pills
| Senders (unseen, within 72 h) | Pill | Row label ends with |
|---|---|---|
| 1, venmo | `Sam sent you $15.10` | `Sam sent you $15.10 on Venmo` |
| 1, cash | `Sam paid you $15.10 in cash` | `Sam paid you $15.10 in cash` |
| 1, other | `Sam paid you $15.10` (SV-UX-16; the spec had `Sam marked $15.10 paid`) | `Sam says they paid you $15.10` |
| 2 or more, any methods | `2 people sent you money` | `2 people sent you money: Sam $15.10, Dee $12.00` (newest first) |
| blank name | `Someone sent you $15.10` | same pattern |

- Tone **muted**, no icon (SV-UX-16). On Home, colour means "your move" (SE-VIS-1). This is news, not a task, and the name plus "sent you" already stand out among the status pills.
- The ower's own pills by method (Sam's view; spec Task 7): `Sent $15.10`, `Paid $15.10 in cash`, `Paid $15.10`; `Sent · $1.10 more to pay` for a venmo mark.

### 7.2 Beside the existing pills (splitit-app-96's layout assumed)
```
Waiting on you
┌─────────────────────────────────────────────────┐
│ Ana's bill                           $38.00   › │
│ Nov 25 · 3 people                     Total     │
│ (New)                                           │  accent
│─────────────────────────────────────────────────│
│ Raj's bill                           $14.80   › │
│ Nov 24 · 4 people                 Your share    │
│ (Not received · $14.80)                         │  accent (SV-UX-15)
└─────────────────────────────────────────────────┘
Recent
┌─────────────────────────────────────────────────┐
│ Your bill                            $44.80   › │  Hana is host + payer
│ Nov 26 · 3 people                     Total     │
│ (Sam sent you $15.10)                           │  muted; was "2 people left to pay"
│─────────────────────────────────────────────────│
│ Dee's bill                           $61.00   › │
│ Nov 23 · 4 people                 Your share    │
│ (Sent $20.00)                                   │  muted; Hana's own send
│─────────────────────────────────────────────────│
│ Your bill                            $90.00   › │
│ Nov 20 · 5 people                     Total     │
│ (2 people sent you money)                       │  muted
│─────────────────────────────────────────────────│
│ Your bill                            $62.00   › │
│ Nov 18 · 3 people                     Total     │
│ (Settled up)                                    │  muted
└─────────────────────────────────────────────────┘
```
- A payer's bill is already in Recent (left to pay, settled), so **the "sent" pill never moves a row between sections**. It only swaps the words on a row that stays put. When Hana owes a pay-back (H6, Waiting), that wins and "sent" waits (spec SV-21).
- Order within Recent stays the list order (HR-9). Sorting news to the top would reshuffle rows each time someone pays.
- **Aging off:** the pill clears when Hana opens that bill (or leaves its bill or Settle screen after watching the send arrive live), or 72 h after the newest send. It then falls back to whatever the row said before: `1 person left to pay`, `Settled up`, or no pill. There's no Dismiss. History is in Activity.
- ~~For Sam, paying moves his row from Waiting on you (`You owe $15.10`, accent) to Recent (`Sent $15.10`, muted).~~ (Superseded, A1: paying his whole share hides the bill from Home; leaving the list is the "done" signal.)

## 8. Bill-screen footer captions

| State (server plan, viewer) | Footer | Caption | Change |
|---|---|---|---|
| Ready, owes, **Venmo** selected | Pay footer: `Pay Hana $15.10 on Venmo` + notes (handle; permission line while undetermined on native; web line) + Details | | spec |
| Ready, owes, **Cash** selected, or Hana has no Venmo | **Cash footer:** `I paid Hana $15.10 in cash` (primary, block) + Details | | **SV-UX-10** |
| Ready, owes, **U!** (not received) | primary `Settle up` | `Hana hasn't received your $15.10` (warning icon) | **SV-UX-11** |
| Inline check applies | `Did your $15.10 to Hana go through?` · `Yes` · `No, undo` · Details | | spec |
| Contract O fallback | `Did you send Hana $15.10?` · `Yes, I sent it` · `Not yet` · Details | | spec copy |
| Ready, marked, no difference | secondary `Settle up` | venmo `Sent to Hana · $15.10`; cash `Paid Hana in cash · $15.10`; other `Marked paid · $15.10` (success icon, live) | **SV-UX-12** |
| Early, marked | secondary `Settle up` | `Sent via Venmo · 1 item left to claim` / `Paid in cash · …` / `Marked paid · …` (success icon, not live) | **SV-UX-12** |
| Early, can pay, unmarked | primary `Settle up` | `You can pay now · 1 item left to claim` | unchanged (no Pay or cash button in the footer before completion, SE-9) |
| Ready, more due / back due | primary `Settle up` | `You owe Hana $1.10 more` / `Hana owes you $1.10 back` | unchanged |
| Payer, everyone settled, no differences | secondary `Settle up` | `Everyone's settled up` (success icon) | **SV-UX-12** |
| Payer, differences | primary `Settle up` | `1 difference to settle` | unchanged |
| Everything else | as today | | |

- **The footer offers the card's primary, whatever the method** (SV-UX-10). Sam reads the selection the card remembered, so a cash payer can finish from the bill screen in one tap, as a Venmo payer can. Changing the method happens on Settle up (Details).
- Marked-ready captions are live (polite), like today's "Marked paid". Early-marked captions aren't, because they'd speak on every claim tap.
- The inline-check footer replaces the marked footer only while the question applies, and follows the same "shown once" rule as the card. Answering in either place answers both.

## 9. Tone

**Words we use and don't:**

| Say | Don't say | Why |
|---|---|---|
| Sent via Venmo / You sent Hana | Paid via Venmo, Confirmed, Completed | The app only knows Venmo opened |
| Paid in cash / Marked paid | Confirmed, Verified | Self-reports |
| settled up (counts and totals) | paid (counts with venmo marks in them) | True for every method |
| You're all set. / Everyone's settled up. Nice. | Success! / Payment complete! | Warm, not loud, and no money claim |
| Hana hasn't received your $15.10. | Payment failed / Rejected / Disputed | Calm; says what happened |
| Check Venmo before paying again. | Warning, Error, "!" | Says what to do |
| Didn't go through? Undo | Cancel payment | Nothing in Venmo is cancelled |
| Not received | Reject, Dispute, Decline | Hana's plain fact |
| Undone. Not marked as sent. | Payment reversed | Nothing moved in Venmo |

**Celebrate completion quietly:**
- Sam, ready, marked, no difference: `You're all set. Hana can see it.` (card), `Sent to Hana · $15.10` (footer).
- Hana, everyone settled: `Everyone's settled up. Nice.` (card label), `Everyone's settled up` (footer), `Settled up` (Home, unchanged).
- No confetti, haptics or animation. Reduce Motion has nothing to turn off.

## 10. Accessibility, platforms and copy edge cases

### 10.1 Labels and hints (new or changed controls)
| Control | `accessibilityLabel` | `accessibilityHint` | Role / state |
|---|---|---|---|
| Chooser group | `How you're paying` | | `radiogroup` |
| Chooser segments | `Venmo` / `Cash` | | `radio`, `selected` |
| Pay (card, footer) | `Pay Hana $15.10 on Venmo, to @hana-1` | `Opens Venmo and records it as sent` | button |
| Cash primary | `I paid Hana $15.10 in cash` | `Records that you paid in cash. Nothing opens.` | button |
| Paid another way | `Paid another way` | `Records that you paid Hana outside SplitIt` | button |
| Inline Yes (card) | `Yes, it went through` | | button |
| Inline No, undo (card) | `No, undo. It didn't go through` | `Clears Sent via Venmo for $15.10` (more: `Asks first. Clears all $16.20`) | button |
| Footer Yes / No, undo | `Yes, my $15.10 to Hana went through` / `No, undo my $15.10 to Hana` | as above | button |
| Didn't go through? Undo | `Didn't go through? Undo` | `Clears Sent via Venmo for $15.10` | button |
| Undo all $15.10 (difference cards) | `Undo all $15.10` | `Clears your whole $15.10, not just the difference` | button |
| Not received (row) | `Not received, Sam's $15.10` | `Asks first, then clears it and lets Sam know` | button |
| Confirm: Not received | `Confirm: Sam's $15.10 not received` | | button |
| Confirm: Cancel | `Cancel: keep Sam's $15.10` | | button |
| Yes, I sent it (fallback) | `Yes, I sent it` | `Records your $15.10 to Hana as sent` | button |

Row labels, everything the row shows in reading order:
- payer viewing: `Sam, $15.10, sent via Venmo`; `Dee, $20.00, paid in cash`; `Raj, $10.10, marked paid`; after Not received: `Sam, $15.10, not paid yet, not received $15.10`.
- own row: `You, $15.10, sent via Venmo` (never "You sent you").
- The inline check isn't part of any row label. It's on the card, with its own buttons.

### 10.2 Announcements
| Moment | iOS (`announceForAccessibility`) | Android / web |
|---|---|---|
| Sent card lands after Pay | `Sent to Hana, $15.10` | `Sent via Venmo` line is live (polite) |
| Inline Yes | `You're all set` | completion line appears in a live slot |
| No, undo lands | `Undone. Not marked as sent.` | card announcement slot (polite) |
| Cash lands | `Marked paid in cash` | `Paid in cash` line is live |
| Cash/other Undo lands | `Marked not paid` (today) | card announcement slot |
| Not received lands (payer) | `Marked not received. Sam will see it.` | Everyone card's caption slot |
| Not-received line arrives live on Sam's card | none | none: it's warning text, not live, so it doesn't interrupt. He reads it when he looks at the card. It's the first line under the amount, so it's read early |
| Opening Venmo | nothing | nothing |
| Errors | `Banner alert` (today) | same |

The inline question isn't a live region. It appears at the same moment as the live "Sent via Venmo" line, and two announcements at once would talk over each other.

### 10.3 Copy at a count of 1 and with "You"
| Template | Count 1 | Count 2+ | With "You" |
|---|---|---|---|
| Payer method line (all settled) | `Sam sent it via Venmo` / `Sam paid in cash` / `Sam marked it paid` | `2 sent via Venmo · 1 paid in cash` | the payer is never an ower, so never "You" |
| Payer progress | `1 of 1 settled up`, `1 settled up so far` | `2 of 3 settled up` | n/a |
| Home sent pill | `Sam sent you $15.10` | `2 people sent you money` (never "1 people") | the payer never has a mark, so "You" never sends |
| Not-received confirm | `Didn't get Sam's $15.10?` | n/a | the target is never the payer |
| Sam's not-received line | names the payer | n/a | the payer is never the viewer on an owes card |
| Notification | names the payer | n/a | blank name → `Did your $15.10 go through?` |
| Row status | `Sent via Venmo` | | own row label `You, $15.10, sent via Venmo` |
| Activity | spec D6 (`You sent Hana $15.10 via Venmo`, `Sam sent you $15.10 via Venmo`) | | |
| $0.01 | `Pay Hana $0.01 on Venmo`, `Sam sent you $0.01`, `Did your $0.01 to Hana go through?` | | |

### 10.4 Web vs native
| | iOS / Android | Web |
|---|---|---|
| Order | write, then open Venmo | open Venmo in the tap, then write |
| Permission note | while undetermined | never |
| Notification | yes, if allowed | none |
| Inline question | on return to the app (pending notifications are cancelled) | on the card when Sam comes back to the tab (it's already there) |
| Popup blocked | n/a | nothing recorded; `Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.` |
| Popup detection unsure | n/a | contract O card `Did you send Hana $15.10?` |
| Computer line | no | `On a computer? Send it from the Venmo app on your phone.` (existing) |
| Chooser | same | same, with keyboard: Tab to the group, arrow keys or Tab between segments, Space/Enter selects. Visible focus ring |

## 11. Things in the spec that add friction, and what this brief does instead

| ID | Friction in the spec | Simpler alternative (built here) | Tag |
|---|---|---|---|
| SV-UX-1 | The chooser's placement and label are unstated; a visible "How you're paying" heading would add a line to every card | Segmented control between the head lines and the primary, no visible label (a11y group label only), hidden with one method, disabled while busy; "Paid another way" under both choices | copy/layout only |
| SV-UX-2 | "A warning line at the top" would move the label/amount slot. "Check Venmo." doesn't say whether to pay again, which risks a double payment | First line under the amount. Venmo copy `Hana hasn't received your $15.10. Check Venmo before paying again.` | copy/layout only |
| SV-UX-3 | A marked card ends on "Sent via Venmo" plus Undo; nothing says you're done | Completion line `You're all set. Hana can see it.` on ready, no-difference marked cards (all methods); early and difference cards keep their own lines | copy/layout only |
| SV-UX-4 | No stated confirmation moment after Pay | No toast (Sam is in Venmo). The card's label and amount are the confirmation; footer caption `Sent to Hana · $15.10`; iOS announcement `Sent to Hana, $15.10` | copy/layout only |
| SV-UX-5 | The card repeats name and amount in the question right under them, so it wraps on a phone | Card: `Did it go through?`. Footer and notification keep the full sentence. Yes → completion line; No, undo → `Undone. Not marked as sent.` | copy/layout only |
| SV-UX-6 | Notification sound and lock-screen preview behaviour unstated (SV-27) | No sound; iOS hidden-preview placeholder `Check your SplitIt payment`; no items, bill name or handles. User's body text unchanged | **changes the spec** (D3 content; adds two options to Task 1's verify list) |
| SV-UX-7 | Permission line copy reads oddly before paying ("a minute later") | `We'll check back in a minute to make sure it went through.`, in the card's and footer's notes while undetermined | copy/layout only |
| SV-UX-8 | (Kept) Denied: no nag | Nothing visible changes; inline still works | copy/layout only (confirms spec) |
| SV-UX-9 | (Kept) Cash has no confirm | One tap, `Undo` on the result; announcement `Marked paid in cash` | copy/layout only (confirms spec) |
| SV-UX-10 | With Cash selected, the footer shows "Settle up", so cash payers need two screens while Venmo payers need one tap | The footer offers the card's primary for every method: cash footer `I paid Hana $15.10 in cash` + Details (ready plans only; early stays "Settle up") | **changes the spec** (D5 footer; criteria 37–39 gain a footer case) |
| SV-UX-11 | After Not received, the footer would show the Pay footer, so Sam could pay again without seeing why | U! footer: primary `Settle up` + warning caption `Hana hasn't received your $15.10` | **changes the spec** (D5 footer; criterion 42 gains a case) |
| SV-UX-12 | Footer captions by method are only given for "marked"; early-marked and payer-all-settled are unstated | Ready: `Sent to Hana · $15.10` / `Paid Hana in cash · $15.10` / `Marked paid · $15.10` (live). Early: `<method words> · N left to claim`. Payer all settled: secondary + `Everyone's settled up` | **changes the spec** (D5 footer table) |
| SV-UX-13 | Not-received confirm copy is formal ("Mark Sam's $15.10 as not received? Sam will be asked to check.") | `Didn't get Sam's $15.10? This clears it and lets Sam know.` with `Not received` (danger) / `Cancel`; after: `Not yet` + sub-line `Not received · $15.10`; announcement `Marked not received. Sam will see it.` | copy/layout only |
| SV-UX-14 | "Everyone's paid", "All N marked paid", "1 of 3 paid" and "All paid" would call Venmo auto-marks "paid" | Counts say "settled up": `1 of 3 settled up`, `1 settled up so far`, aside `All settled up`, label `Everyone's settled up. Nice.` + method line `2 sent via Venmo · 1 paid in cash` (one ower: `Sam sent it via Venmo`). Departs from the user's example wording "Everyone's paid. Nice." to keep their "never untrue" rule | copy/layout only (flagged as a wording departure) |
| SV-UX-15 | After Not received, Sam's Home row goes back to a bare `You owe $15.10` with no reason, and he gets no notification | Home pill `Not received · $15.10` (accent, Waiting on you). Data: `my_bills()` also returns the caller's own `not_received_cents` and `not_received_by` (own row, no new exposure), and `billMarker` gives a `not_received` marker when `not_received_by` is the current payer and the viewer is unmarked. Needs one entry added to `WAITING_MARKERS` in `lib/homeSections.ts` (splitit-app-96's OK, like the fixture). If declined: the spec's `You owe $15.10` | **changes the spec** (D7 contract S, D8 `my_bills`, Task 7; a second approved line in splitit-app-96's file) |
| SV-UX-16 | `Sam marked $15.10 paid` is awkward on a pill; the "sent" pill's tone and placement need confirming | `Sam paid you $15.10` (a11y `Sam says they paid you $15.10`); muted, no icon, stays in Recent, list order unchanged | copy/layout only |
| SV-UX-17 | "Couldn't open Venmo. Send $X to @y in the Venmo app." leaves the person without a way to record it | Adds `, then tap Paid another way.` (native open failure and web blocked popup) | copy/layout only |
| SV-UX-18 | `Undo "I paid"` reads oddly next to a "Sent" mark, and SV-13's confirm (`This clears your whole "Sent" of $16.20`) is hard to parse | Difference cards: `Undo all $15.10` for every method. More-send undo confirm: `Undo all $16.20? You can only undo the whole amount, not just the $1.10.` with `Undo all` / `Keep it` | copy/layout only |
| SV-UX-19 | "Your payment to Hana changed since then. Check below." doesn't say whether anything happened | `Your payment to Hana changed since then, so nothing was undone. Check below.` | copy/layout only |
| SV-UX-20 | (Kept) Contract O fallback card layout | Primary `Yes, I sent it`, note handle, ghost `Open Venmo again` (opens only); footer adds `Not yet` | copy/layout only (confirms spec) |
| SV-UX-21 | Inline question and "Sent via Venmo" would both announce at once | The question isn't live; its buttons carry the context in their labels | copy/layout only |
| SV-UX-22 | More-due summary `You've marked $15.10 paid.` is wrong for a cash mark and stiff for venmo | `You've sent $15.10.` (venmo) / `You've paid $15.10.` (cash, other) | copy/layout only |

## 12. Copy reference (new or changed; `lib/settleView.ts`, `lib/sentCheck.ts`, `lib/paymentMethods.ts`, `lib/homeMarkers.ts`)

| Key (suggested) | Copy |
|---|---|
| chooserA11y / methodLabel | `How you're paying` / `Venmo`, `Cash` |
| payButton (unchanged) / payHint | `Pay <Payer> $X on Venmo` / `Opens Venmo and records it as sent` |
| cashButton / cashHint | `I paid <Payer> $X in cash` / `Records that you paid in cash. Nothing opens.` |
| cashMoreButton | `I paid the $D in cash` |
| otherWay / otherWayHint | `Paid another way` / `Records that you paid <Payer> outside SplitIt` |
| cashOnlyLine | `<Payer> hasn't added Venmo yet.` |
| permissionLine | `We'll check back in a minute to make sure it went through.` |
| sentLabel / paidLabel (unchanged) | `You sent <Payer>` / `You paid <Payer>` |
| markLine (by method) | `Sent via Venmo` / `Paid in cash` / `Marked paid` |
| allSetLine | `You're all set. <Payer> can see it.` |
| sentCheckCard / sentCheckFull | `Did it go through?` / `Did your $X to <Payer> go through?` (blank: `Did your $X go through?`) |
| sentCheckYes / sentCheckUndo | `Yes` / `No, undo` |
| sentUndoGhost | `Didn't go through? Undo` |
| undoAll / undoAllMoreConfirm | `Undo all $X` / `Undo all $Y? You can only undo the whole amount, not just the $D.` (`Undo all` / `Keep it`) |
| sentCheckChanged | `Your payment to <Payer> changed since then, so nothing was undone. Check below.` |
| undoFailed | `Couldn't undo. Try again.` |
| fallbackLabel / fallbackYes | `Did you send <Payer> $X?` / `Yes, I sent it` |
| openFailedText (changed) | `Couldn't open Venmo. Send $X to @handle in the Venmo app, then tap Paid another way.` |
| diffLine (changed) | `Your share is now $Y. You've sent $X.` / `Your share is now $Y. You've paid $X.` (mark 0: `Your share is now $Y.`) |
| notReceivedLine | venmo `<Payer> hasn't received your $X. Check Venmo before paying again.`; cash `<Payer> hasn't received your $X in cash.`; other `<Payer> hasn't received your $X.` |
| payerProgress / payerEarlyProgress | `<p> of <n> settled up` / `<p> settled up so far` |
| payerAllSettledLabel | `Everyone's settled up. Nice.` |
| payerMethodLine | `<n> sent via Venmo` · `<n> paid in cash` · `<n> marked paid` (joined ` · `); one ower: `<Name> sent it via Venmo` / `<Name> paid in cash` / `<Name> marked it paid` |
| allPaidAside (changed) | `All settled up` |
| rowStatus | `Sent via Venmo` / `Paid in cash` / `Paid` |
| rowNotReceived / rowNotReceivedSub | `Not received` / `Not received · $X` |
| notReceivedConfirm | `Didn't get <Name>'s $X? This clears it and lets <Name> know.` (`Not received` / `Cancel`) |
| footerMarked | `Sent to <Payer> · $X` / `Paid <Payer> in cash · $X` / `Marked paid · $X` |
| footerEarlyMarked | `Sent via Venmo · <n> left to claim` / `Paid in cash · <n> left to claim` / `Marked paid · <n> left to claim` |
| footerNotReceived | `<Payer> hasn't received your $X` |
| footerPayerSettled | `Everyone's settled up` |
| announce | `Sent to <Payer>, $X` · `You're all set` · `Undone. Not marked as sent.` · `Marked paid in cash` · `Marked not received. <Name> will see it.` |
| notification | title `SplitIt`; body = sentCheckFull; actions `Yes`, `No, undo`; hidden preview `Check your SplitIt payment` |
| Home pills | `Sam sent you $X` · `Sam paid you $X in cash` · `Sam paid you $X` · `<n> people sent you money` · `Someone sent you $X` · `Not received · $X` · own: `Sent $X` · `Paid $X in cash` · `Paid $X` · `Sent · $D more to pay` |

Strings this changes that tests assert today (for Tasks 6/9 to update; run the Grep tool first, not run for this brief): `SETTLE_COPY.allPaidAside` ("All paid"), `payerAllPaidLabel` ("Everyone's paid"), `payerAllPaidLine`, `paidOfText`, `paidSoFar`, `undoMark` (`Undo "I paid"`), `diffLine`, `openFailedText`, `alreadyPaid` (spec already renames it), and every `Did you pay` string (spec's planned-breakage list).

## 13. Notes for the visual designer and the staff engineer

**Visual:**
- The chooser is the existing `SegmentedControl`, full card width, between the lines and the primary. Check that its selected state differs by more than colour (weight or a raised thumb) in both themes.
- Row status column: `Sent via Venmo` and `Paid in cash` are wider than `Paid`. Use the wide status width (SE-VIS-6) whenever a row shows a method status, and check wrapping at 375 pt and with large text.
- Inline check: a muted caption, then `Yes` and `No, undo` as flush ghosts on one wrapping row, `space.lg` apart (the card secondary row's spacing). It must not look like a second card.
- The not-received line is the card's only warning-tone line. Icon from tone (TriangleAlert), 600 weight like other toned lines.
- U! footer caption: warning icon + muted text (the footer has a success-only tone today; it gains `warning`).
- Long payer names: `I paid Hana Lee-Watanabe $15.10 in cash` must wrap in the block button, not truncate.
- Notification: nothing to style. iOS draws it.

**Engineering, model changes this brief adds:**
- Footer: a `cash` footer kind mirroring `pay` (SV-UX-10); U! caption with a warning tone (SV-UX-11); method captions, early method captions and the payer-settled caption (SV-UX-12). The footer still derives from `settleCard`, so card and footer can't disagree (lesson 2026-11-25, one status source).
- Card: an `allSetLine` slot (hidden while the inline check shows); the inline-check slot holds `Did it go through?` on the card and the full sentence in the footer (SV-UX-5); the more-send undo confirm (SV-UX-18).
- Payer card: method counts from the plan's marks (`method` on `BillMark`), with no money arithmetic.
- Home: `not_received` marker and the caller's own flag through `my_bills()` (SV-UX-15). Coordinate the one `WAITING_MARKERS` line with splitit-app-96 before Task 7.
- Notification content: `sound` off and the iOS hidden-preview placeholder (SV-UX-6), both to verify in Task 1 against the installed `expo-notifications`; reword if the option names differ.
- Announcements: one card-level polite slot is reused for undo and inline answers. The inline question itself is never a live region.
