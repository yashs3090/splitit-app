# Who paid: UX and UI review, before build

Date: 2026-11-26. Reviews `docs/specs/2026-11-26-who-paid.md` (D6, D7, D11, D12 and the Settle parts of D9) and decisions WP-1 to WP-25. **Nothing is built, and no code or spec was changed.** This document proposes amendments. The spec's owner applies the ones the user accepts.

Method: design review only. The impeccable detector doesn't apply: this is a native/adaptive surface, and there's no markup yet. Skills used: impeccable (context, critique, critique-rubric, harden, ios, android), ui-ux-designer, emil-design-eng, apple-design, gestures.

Read for this review: `PRODUCT.md`, `DESIGN.md`, the spec, `docs/decisions-to-review.md` (Who paid), `app/(app)/bills/[id]/index.tsx`, `app/(app)/bills/[id]/settle.tsx`, `components/PayerPicker.tsx`, `components/ItemSheet.tsx`, `components/TipOptions.tsx`, `components/ui/*` (SegmentedControl, StatusLine, TextField, TextLink, Button, Banner), `lib/theme.ts`, `lib/money.ts` (`parseMoneyInput`), `docs/learning/concepts/design-system.md`, the `[area: expo]` lessons, and the Sent-via-Venmo UX brief and visual doc (`2026-11-26-sent-via-venmo-ux.md`, `-visual.md`).

Worked example throughout (spec T1): **Hana** (host) and **Sam** paid a $100.21 bill, Hana $60.00 and Sam $40.21. **Dee** didn't pay. Shares: Hana $33.41, Sam $33.40, Dee $33.40. Transfers: Dee → Hana $33.40, Hana → Sam $6.81.

---

## 1. Verdict

The spec has the right shape for the user's brief. The feature is hidden behind one quiet line. The common path (one person) stays one tap. Split mode needs a deliberate Save. Contract T gives every non-payer exactly one Venmo link, which is the most important UX property of the whole feature. Copy is plain, and most hard states are named.

Five things would hurt people at the table if they were built as written:

1. **The keyboard hides Save and the running line** in split mode. The sheet has no keyboard handling (ItemSheet has none to copy), and the iOS decimal pad has no Return key.
2. **"Add the rest" appears under the focused row.** Rows jump as focus moves. On web, the tap blurs the field first, so the button unmounts before the click lands.
3. **"Paid by You · Edit" sits directly above "Edit items".** That's two "Edit"s stacked in the header. Settle already says "Change" for exactly this action, and the Sent-via-Venmo shell keeps "payer line + Change".
4. **The WP-7 confirm says "They'll need to mark them again."** After Sent via Venmo, many of those marks are real money. The copy should say what happens to it, and the people who were cleared aren't told anything.
5. **Two "You owe" cards means two filled primaries** on one screen, which breaks the one-primary rule (DESIGN.md, Sent-via-Venmo §1).

All five are fixable inside the spec's design. None needs a new screen or a new colour.

### Heuristic scores (the spec as written)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | The running line is good. The sheet closes before the refetch lands, so the line can briefly show the old payer (M10) |
| 2 | Match with the real world | 3 | "Split the paying" collides with the app's "split" (items, extras). "Left to assign" is fine |
| 3 | User control and freedom | 2 | iOS swipe-to-dismiss can't be intercepted for "Discard changes?" (M7). Tap-to-save has no undo, but its confirm covers the risky cases |
| 4 | Consistency and standards | 2 | Edit vs Change; StatusLine has no neutral or warning tone; the radio position differs from ItemSheet's person rows |
| 5 | Error prevention | 3 | Save is gated on adding up exactly. Invalid input never counts as $0 |
| 6 | Recognition rather than recall | 3 | In split mode the one-person tab would show the lead as checked (M5) |
| 7 | Flexibility and efficiency | 3 | "Add the rest" is the right accelerator, in the wrong place |
| 8 | Aesthetic and minimalist design | 3 | Quiet line, one sheet. The empty "Split the paying" tab when alone is noise (M6) |
| 9 | Error recovery | 2 | People whose marks are cleared get no explanation. The stale state is clear for the host but long in the header |
| 10 | Help and documentation | 3 | The "why" of who pays whom on a two-payer Settle is missing (S5) |
| **Total** | | **27/40** | **Acceptable.** About 33/40 (Good) with the must and should amendments |

**Cognitive load:** 2 checklist failures. "One thing at a time" fails because split mode shows the gap, "Add the rest", the K note and Save together. "Working memory" fails because a co-payer on Settle has to reconstruct why they pay Sam. Moderate; fixed by M2, S5 and S7.

**Personas:**
- **Casey** (distracted, one-handed): the keyboard covers Save, and "Add the rest" moves under the thumb.
- **Sam** (VoiceOver): the Android live region speaks on every keystroke. On iOS, nobody hears that Save became available.
- **Riley** (stress tester): a European-locale decimal pad types `40,21`, which `parseMoneyInput` rejects (app-wide, C6). Opening the sheet on a split bill and tapping the "checked" lead in the one-person tab changes the mode while looking like a no-op.
- **Hana** (host at the table, project persona): right after a scan, the "Split the paying" tab is a dead end with one person. Dee (who already sent Hana $33.40 on Venmo) is silently reset to "You owe Sam" after Hana switches payers.

---

## 2. Amendments

Tags: **Must**: fix before building Task 9/10, or the flow breaks for someone. **Should**: clearly better, cheap. **Could**: nice, or needs more thought. "Spec:" names the section each one changes. Copy in `code` is exact. Every token is an existing one from `lib/theme.ts`. **No new colours or sizes.**

### Must

**M1. The sheet's footer rides above the keyboard (split mode).** Spec: D7, D12, Task 9.
- Split mode has a sticky sheet footer: the status line, the "Add the rest" slot, then one row with `Cancel` (ghost) and `Save` (primary, `flex: 1`). Rows scroll above it.
- Footer style: `colors.surface`, top hairline `colors.divider`, `paddingTop: space.md`, `paddingHorizontal: space.lg`, `gap: space.sm`, plus `insets.bottom` when the keyboard is down.
- Wrap the sheet body in `KeyboardAvoidingView`: `behavior="padding"` on iOS. On Android, verify inside the `Modal` window (the Modal doesn't inherit the activity's resize mode; `app.json` doesn't set `softwareKeyboardLayoutMode`). On web, check on a real phone that the footer stays reachable; at minimum it must scroll into view.
- **The iOS decimal pad has no Return key.** Don't rely on `returnKeyType="next"`. People tap the next field. `keyboardShouldPersistTaps="handled"` (already on ItemSheet's ScrollView) keeps that a single tap. No input-accessory toolbar: it adds chrome for a 2–3-field form.
- Height budget on a 375 × 667 phone with the keyboard up: about 340 pt visible. Footer about 96 pt, title line 28, segments 44, gaps 32. That leaves about 140 pt, so 2 rows show and the rest scroll. That's acceptable. Without a sticky footer, Save is off screen.

**M2. "Add the rest" lives in the footer, names its target, and doesn't depend on live focus.** Spec: D7.
- Slot: in the footer, under the status line. It's a `TextLink` (caption 13/600, `primary`, 44 tall).
- Copy: `Add the rest ($40.21) to Sam`. For the viewer: `Add the rest ($40.21) to you`. a11y label: `Add the rest, $40.21, to Sam`. Hint: `Sets Sam's amount to $40.21` (the field's value plus the gap; with an existing $10.00: `Sets Sam's amount to $50.21`).
- Target: the **last focused** row. It stays the target until another field is focused, so a blur doesn't remove it. That fixes the web mousedown-blur race and the layout jumps.
- Show it when the gap is > 0 and the target's field is blank or valid. Before any field has been focused: if exactly one row is blank and at least one has an amount, target that blank row. Otherwise hide it.
- It doesn't move focus. On iOS it announces the new status (M4).

**M3. Status tones from words, not colour; StatusLine gains two tones.** Spec: D7 contract A; `components/ui/StatusLine.tsx`.

| Status | Tone | Icon | Colour on `surface` (light / dark) |
|---|---|---|---|
| `$40.21 left to assign` | **muted** (it's progress, not a problem) | none | `textMuted` 7.56 / 7.98 |
| `$3.00 more than the total` | **warning** (DESIGN.md: totals that don't add up) | TriangleAlert | `warning` 7.52 / 11.18 |
| `Adds up to $100.21` | success | Check | `success` 5.69 / 10.69 |
| `Fix the amount marked above` (plural: `Fix the amounts marked above`) | error | the circle icon from ToneIcon | `danger` 6.57 / 8.91 |

- `StatusLine` gets `tone: 'success' | 'error' | 'warning' | 'muted'`. Muted draws no icon. The default stays `success`, so every current caller is unchanged.
- Amounts in the line use `tabularNums`. They change on every keystroke, and proportional digits would make the line jitter.
- Type: `label` (15/600), as StatusLine does today. Not caption: this line is the sheet's feedback, and it needs to be read at arm's length in dim light.

**M4. One debounced announcer; the visible line isn't a live region.** Spec: D12, R4.
- The visible status updates on every keystroke and is **not** live (`accessibilityLiveRegion` off). On Android, a polite live region speaks on every content change, and the amount changes on every digit.
- Announce once typing pauses for 700 ms, and on blur, only when the status kind or amount differs from the last announcement. Use `AccessibilityInfo.announceForAccessibility` on iOS **and** Android (it works on both). On web, use a polite `aria-live` text that renders the debounced string; verify that react-native-web maps it.
- Spoken copy:
  - short: `$40.21 left to assign`
  - over: `$3.00 more than the total`
  - adds up: `Adds up to $100.21. You can save now.`
  - invalid: `Sam's amount isn't valid. Enter an amount like 12.50.`
- "You can save now" is what a screen-reader user needs: the Save button became enabled somewhere below.
- Save while disabled: hint `Amounts must add up to $100.21 first`, replacing D12's `Adds up when nothing is left to assign`.

**M5. On a split bill, the one-person tab has no row checked.** Spec: D7 "One person".
- Showing the lead as checked makes tapping them look like a no-op, but it actually switches the mode.
- Show a muted caption above the rows: `Tap the person who paid the whole bill.` Every radio is `checked: false`.
- Tapping any name follows `pickerDecision` (K confirm) as the spec says.

**M6. No dead tab.** Spec: D7, D11 row 1.
- With fewer than 2 participants, or a total under 2¢, **don't render the SegmentedControl at all**. The sheet is the one-person list, plus (alone) `Others show up here once they join.` and `Add people`.
- Right after a scan, the host sees `You`, checked, and the way to add Sam. They never see a second tab that only says "you can't use this".
- The `Split the paying needs …` copy then isn't needed. Keep it only as the defensive state if a participant leaves while split mode is open (it renders in place of the rows).

**M7. Dismissal: what each exit does.** Spec: D7 states table ("Unsaved edits + close"). Lesson 2026-11-25 (every way to close).

| Exit | Clean (nothing typed or changed) | Dirty |
|---|---|---|
| iOS swipe down | closes | **blocked** (`allowSwipeDismissal={!dirty}`, the ItemSheet precedent VP-37a). RN `Modal` can't intercept a swipe to ask first, so the spec's "swipe → Discard?" isn't buildable |
| `Cancel` / `Done` | closes | inline confirm in the footer |
| Android Back, scrim tap, web Escape (`onRequestClose`) | closes | inline confirm in the footer |
| Saving in flight | nothing closes | nothing closes |

- Inline confirm: a warning Banner in the footer that replaces the Save row. Text `Discard your changes to who paid?`, buttons `Discard` (danger) and `Keep editing` (ghost). No system Alert, per the no-modals rule.
- "Dirty" means any field differs from its prefill. Switching segments doesn't make the sheet dirty on its own.

**M8. Rewrite the WP-7 confirms for real money.** Spec: D7, `pickerDecision` copy (Task 7). Sent-via-Venmo vocabulary: "settled up" covers every method (SV-UX-14).
- **One person, K > 0** (the old payer is the viewer):
  - Banner title: `Dee and Pat already settled up with you`
  - Text: `Switching to Sam clears their payments, and they'll be asked to pay Sam instead. Sort out what they sent you outside the app.`
  - Buttons: `Switch to Sam` (danger), `Cancel` (a11y `Cancel: keep you as the payer`)
- **Old payer is someone else** (Hana changes the payer from Sam to Dee): title `Pat already settled up with Sam`; text `Switching to Dee clears Pat's payment, and Pat will be asked to pay Dee instead. Sam and Pat will need to sort out what Pat sent.`
- **Split save, K > 0:** title `Pat already settled up with Sam`; text `Saving takes Sam off who paid, so Pat's payment is cleared and Pat will be asked to pay again. Sort out what Pat sent Sam outside the app.` Buttons: `Save and clear` (danger), `Cancel`.
- **K = 0, complete:** keep `Switch to Sam? People may already be paying you.`
- **Split, K = 0, marks present** (the note above Save): `Dee already settled up. Changing amounts may leave Dee a difference to settle.` (two or more names: `Dee and Pat already settled up. Changing amounts may leave them a difference to settle.`)
- Names: up to 3, then `Dee, Pat and 2 others`. This follows the existing join rule in `lib/settleView.ts`.
- The confirm sits **in the footer** in split mode, and directly under the list in one-person mode. Either way, it's next to the control that triggered it.

**M9. One primary on Settle, even with two "You owe" cards.** Spec: D9 settleView bullet, Task 10. DESIGN.md "one filled button per screen".
- Cards are ordered larger amount first, then by name. **Only the first unmarked card** uses the filled primary for its Pay (or cash) button. Later unmarked cards use the same button as `secondary` (`primarySurface` fill, `primary` text; 4.84 / 7.80 against each other: AA).
- When the first card is marked, the next unmarked one becomes primary. There's still one next step at a time, and every link stays one tap away.
- Each card keeps its own Sent-via-Venmo chooser (§1 of their visual doc), and the chooser selection is shared (one remembered method per device).
- Bill-screen footer when you owe two or more people: **primary** `Settle up`, caption `You owe 2 people · $30.00` (the sum from contract O). The spec's WP-19 uses secondary, but secondary means "done" in the Sent-via-Venmo footer table, and here the person still owes money.

**M10. Close on refetch, and return focus to the line.** Spec: D7 states ("Saved").
- One person: the tapped row keeps its spinner until the refetch after `set_payer` **finishes** (lands, or fails per the existing `finished` rule). Then the sheet closes. Otherwise the line shows the old name for a moment after closing, which reads as "it didn't work".
- Split: same, with Save's spinner.
- After closing, focus goes to the line (`AccessibilityInfo.setAccessibilityFocus` on its node). iOS also announces the new line text, e.g. `Paid by Sam`.
- If the refetch failed: close the sheet, and the line area shows the existing `Live updates paused · Refresh` row. The save itself succeeded.

### Should

**S1. One row anatomy in both modes: the name never moves.** Spec: D7.
```
(avatar) Name ........................ [trailing]
```
- 56 pt rows (`ROW_MIN_HEIGHT`), `gap: space.md`, the `Avatar` from `components/Avatars` (same as ItemSheet's person rows).
- Trailing, one person: radio icons `CircleDot` / `Circle` at 24 (`iconSize.lg`), `primary` when checked and `textMuted` when not. Taken from PayerPicker, which Task 10 deletes, so the sheet becomes the pattern's only home. The checked name uses weight 600 (shape plus weight, not colour alone).
- Trailing, split: the amount field, `$` prefix, `numeric`, `keyboardType="decimal-pad"`, 128 pt wide (fits `$99,999.99` at 16 pt). The `TextField` label is a11y-only: `Amount you paid` / `Amount Sam paid`.
- The whole one-person row is the radio target (44+ tall). In split mode, only the field is interactive. The name and avatar are one non-interactive element.
- At the two largest accessibility text sizes, a split row stacks: the name on top, the field full width under it (a `flexWrap` row, so nothing clips).

**S2. Title line: `Who paid?` with the total on the right.** Spec: D7 container.
- Use ItemSheet's `titleLine`: `type.title` heading, `MoneyText size="title"` on the right. The pair reads as "who paid the $100.21?". The total is the sheet's largest figure (Receipt Column Rule), and the line saves 22 pt over a separate `Bill total $100.21` caption, which matters on small phones (M1).
- The heading's a11y label: `Who paid? Bill total $100.21`.

**S3. Segment labels: `One person | Several people`.** Spec: D7. **Needs the user's decision (U3).**
- "Split" already means item splits ("Split differently", "Split 2 ways") and extras ("Split proportionally") in this app. A third meaning in the same session invites confusion.
- `Several people` is parallel with `One person` and shorter (it holds one line at large text in a stretched control).
- Group label: `How many people paid` (replaces `How it was paid`).
- Control: the existing `SegmentedControl`, `stretch`, `semantics="radio"`, directly under the title line, `space.lg` above the rows. Stretch (not hug) is right here, unlike the Settle chooser: it's the sheet's top-level mode, there's no filled button directly under it in one-person mode, and iOS draws sheet-level segmented controls full width.

**S4. Everyone, grouped by who receives.** Spec: D9 (`Dee pays Hana · $33.40 · Not yet` rows).
- At 375 pt with the 120 pt status column, `Dee pays Hana` gets about 117 pt, so it wraps on almost every row. Group the rows under small `section` labels (13/600 `textMuted`) instead: `Paying you`, `Paying Sam`. Each row keeps today's anatomy (name, amount, status, controls).
- Payer-to-payer transfers sit in their recipient's group (`Paying Sam` → `You $6.81`).
- With one payer there's one group, so **no section label** is shown, and the list looks exactly like today.
- Row a11y: `Dee, $33.40 to you, not paid yet` / `You, $6.81 to Sam, not paid yet`.

**S5. Say why on a two-payer Settle.** Spec: D9, D11.
- Non-payer card, in the muted status-lines slot (Sent-via-Venmo anatomy: under the amount, above the chooser): `Hana and Sam split the paying. Paying Hana covers your share.` This answers "do I also owe Sam?" before anyone asks.
- Payer, under the payer line in the Settle header (body, `textMuted`): `You paid $60.00 · your share is $33.41`. Then the cards and rows show where the difference goes. No arithmetic sentence beyond that.
- Three payers (T5), the heading above two cards: `You owe 2 people · $30.00` (section, `textMuted`).

**S6. The stale state in few words.** Spec: D6, D11.

| Where | Host | Others |
|---|---|---|
| Bill line | TriangleAlert (16, `warning`) + `Who paid doesn't match the new total · Fix` (`warning`, 600; 6.83 / 12.43 on `background`) | `Waiting for Hana to update who paid` (`textMuted`, no icon: nothing for them to do) |
| Line a11y | `Who paid doesn't match the new total. Fix who paid` | plain text |
| Sheet, opened stale | info Banner above the rows: `The bill total changed to $103.21. Update the amounts so they add up.` Then the stored amounts, status `$3.00 left to assign`, and `Add the rest ($3.00) to you` (one tap fixes the common case: a tip change) | n/a |
| Settle card | title (label, `warning`, TriangleAlert): `Who paid doesn't match the bill total`; line `$100.21 of $103.21 is assigned.`; **primary** `Fix who paid` (opens the sheet) | same title and line; `Hana needs to update it before anyone can settle up.` No button |
| Bill footer | primary `Settle up`, caption `Who paid needs fixing` (TriangleAlert in `warning`, text `textMuted`, the SV-VIS-13 pattern) | secondary `Settle up`, caption `Waiting for Hana` |

The D6 sentence `Who paid adds up to $100.21. $3.00 left to assign.` is too long for a header line. The numbers belong in the sheet.

**S7. One status line, never two.** Spec: D7 contract A.
- Drop the stacked `Enter amounts for at least 2 people` + gap line. Fewer than 2 people with an amount and gap ≠ 0: show the gap line only (it already implies "keep going").
- Fewer than 2 with gap = 0 (one person has the whole total): `That's one person paying the whole bill.` plus a `TextLink`, `Sam paid it all` (viewer: `You paid it all`). It saves Sam as the one payer through `set_payer`, with the usual one-person confirm rules, as if Sam's row had been tapped in the one-person tab. **Behaviour detail for the PM.**

**S8. Errors go in the footer slot.** Spec: D7 error table.
- With the keyboard up, a Banner at the top of the sheet is off screen. Show save errors as an `alert` StatusLine (error tone) in the status slot, replacing the running line until the next edit. This is the bill footer's compact-error pattern (V13).
- `marks_changed` and `payers_total` also refetch, as the spec says.
- The one-person mode keeps a Banner under the list (no keyboard there).

**S9. Save needs a change, as in ItemSheet.** Enabled only when contract A says `canSave` **and** the draft differs from what's stored. Opening a valid split and saving it unchanged is the step 6 no-op, so the button shouldn't offer it.

**S10. Focus and drafts.**
- Switching to split from one-person mode focuses the first row's field (the viewer), so the keyboard comes up ready (TipOptions' custom field does the same).
- Opening the sheet on an existing split doesn't autofocus. People are reviewing, and the keyboard would cover the amounts.
- Switching segments keeps typed amounts in memory for the sheet's lifetime, so a mis-tap on `One person` loses nothing.

**S11. Tapping the checked row closes the sheet** (one-person mode, one-person bill). Today's Settle picker does the same. "No-op" shouldn't mean "nothing visible happens".

**S12. Co-payers learn why they can't leave before they tap.** Spec: D11.
- `LeaveBill` already gets `canLeave`. When the reason is "you're a payer", show the reason in place of the button: `You're one of the people who paid. Ask Hana to change who paid before you leave.` Don't show it as a refusal after a tap.
- Host's Remove on a co-payer: `Sam paid part of the bill. Change who paid first.` plus ghost `Change who paid`, which opens the sheet (people screen → bill → sheet; if that navigation is out of scope, keep the copy only).
- The DB code stays `cannot_leave`. The copy is chosen from local data.

**S13. `you` in lower case mid-sentence.** `Paid by you`, `Paid by you $60.00 and Sam $40.21`. `nameOf` returns `You` for list rows and sentence starts. In the middle of a sentence a capital reads like a name. Sentence-initial stays `You` (`You changed who paid: …`). **Copy: needs the user's OK (U2)**, because their decision text says "Paid by You".

**S14. Field errors are words under the row, no icon inside the field.** D12 asks for "an error border plus an icon". The 128 pt field has no room for an icon. `TextField`'s `invalid` (2 pt `danger` border) plus a caption under the row in `danger` (`Enter an amount like 12.50` / `That amount is too large`) is the pattern every other field uses, and the words make it not colour-only. The field's a11y hint carries the error (TextField does this already).

**S15. Extract a `Sheet` primitive.** Two sheets (ItemSheet and this one) now share the Modal shell: page sheet on iOS, scrim and rounded sheet elsewhere, `accessibilityViewIsModal`, safe-area padding. This one adds the keyboard avoidance, the sticky footer slot and the dirty guard. Put the shell in `components/ui/Sheet.tsx` (props: `dirty`, `footer`, `onRequestClose`) and move ItemSheet onto it in the same task, with no visible change to ItemSheet. This is the "fix the system, not the screen" rule. Task 9's estimate grows by about 80 lines.

### Could

- **C1. Names only in the line** (`Paid by you and Sam · Change`). Amounts stay in the sheet and on Settle. It's quieter, but non-hosts would lose the amounts unless they open "See who". Recommendation: keep the spec's amounts (it's an honest ledger) and revisit after the friend test. **U5.**
- **C2. Non-hosts with 4+ payers:** `Paid by Hana, Sam and 2 others`, with no "See who" sheet. That removes a read-only sheet variant for a rare × rare case.
- **C3. A symmetric fix for "over":** `Take $3.00 off Hana` in the same footer slot when the gap is < 0 and the target's amount is ≥ the overage plus 1¢.
- **C4. Expo Router `formSheet` with detents** (`sheetAllowedDetents: [0.5, 1]`, grabber) for both sheets: a half-height one-person list, growing to full height for split. This is a navigation change (a route, not a Modal), so it's a later, app-wide decision.
- **C5. A heads-up on Edit items for split bills:** a muted caption under the total field, `More than one person paid. If the total changes, you'll update who paid next.` This is prevention for WP-9.
- **C6. Comma decimals (app-wide).** iOS shows `,` on the decimal pad in many locales, and `parseMoneyInput` reads `40,21` as invalid. The app is US/Venmo-first, so it's low priority, but it's a real dead end for a visitor's phone. It's a `lib/money.ts` decision, not this slice's.
- **C7. Web keyboard:** Enter in any amount field = Save when enabled. Escape = close, through M7's guard (verify react-native-web's `Modal` calls `onRequestClose` on Escape).
- **C8. Tidy on blur:** a valid `60` shows as `60.00` after leaving the field (`formatCentsInput`). It reads like a receipt and confirms the parse. This is display only; the stored value doesn't change.
- **C9. Reopen the sheet after Add people**, when the host came from the sheet. This is navigation, so it's a PM call.

---

## 3. Mocks (375 pt, light; dark uses the same tokens)

`▓` = filled `primary`. `(HN)` = avatar. `▲` = TriangleAlert, `✓` = Check, `ⓘ` = info, from tone (never in the copy).

### 3.1 The line, bill-screen header

```
Your bill                                  title 22/700
Total $100.21                              body, textMuted
Paid by you · Change                       ONE button, minHeight 44, pressed 0.7
                                             "Paid by you" body textMuted
                                             " · " textMuted (decorative)
                                             "Change" label 15/600 primary
Edit items                                 ghost, flush start (unchanged)
```
- Gaps: header `gap: space.xs`, as today. The 44 pt boxes give about 15 pt Total→line and 26 pt line→Edit items, so Total and Paid-by read as one pair and the action sits apart. **Don't use `hitSlop`** to shrink the box: it would overlap Edit items' target.
- Contrast on `background` (table grey): `textMuted` 6.87 / 8.87, `primary` 4.97 / 10.32. Both pass AA for text.
- Web: the focus ring goes around the whole line.

```
Split, host                                Split, others            4+ payers, others
Paid by you $60.00 and Sam $40.21 ·        Paid by Hana $60.00      Paid by 4 people · See who
Change                                     and Sam $40.21
```
At 375 pt the split line wraps after the `·`, and `Change` falls to line 2. That's fine, because the whole block is one target. Amounts are tabular.

```
Stale, host                                Stale, others
▲ Who paid doesn't match the new           Waiting for Hana to update who paid
  total · Fix
```

### 3.2 Sheet, one person (iOS page sheet; Android/web: the same body over the scrim)

```
┌──────────────────────────────────────┐
│ Who paid?                    $100.21 │  title + MoneyText title (S2)
│                                      │  16
│ ┌─────────────────┬────────────────┐ │  SegmentedControl stretch, radio,
│ │▓▓ One person ▓▓▓│ Several people │ │  group "How many people paid"
│ └─────────────────┴────────────────┘ │
│                                      │  16
│ (HN) You                         (●) │  56 row; checked name 600
│ (SM) Sam                         ( ) │
│ (DE) Dee                         ( ) │
│                                      │  24
│ [            Done                  ] │  secondary block (ItemSheet's Done)
└──────────────────────────────────────┘
```
Tapping Sam (no marks, incomplete bill): Sam's radio shows a spinner and every row dims to 0.5. When the refetch lands, the sheet closes and focus goes to `Paid by Sam · Change` (M10).

**Alone, right after a scan** (M6, no segments):
```
┌──────────────────────────────────────┐
│ Who paid?                    $100.21 │
│                                      │
│ (HN) You                         (●) │
│ Others show up here once they join.  │  caption textMuted
│ Add people                           │  ghost, flush start → /bills/<id>/people
│                                      │
│ [            Done                  ] │
└──────────────────────────────────────┘
```

**On a split bill, the one-person tab** (M5):
```
│ ┌─────────────────┬────────────────┐ │
│ │▓▓ One person ▓▓▓│ Several people │ │
│ └─────────────────┴────────────────┘ │
│ Tap the person who paid the whole    │  caption textMuted
│ bill.                                │
│ (HN) You                         ( ) │  nothing checked
│ (SM) Sam                         ( ) │
```

**Confirm, K > 0** (under the list; M8):
```
│ (SM) Sam                         ( ) │
│ ┌──────────────────────────────────┐ │  warning Banner
│ │ ▲ Dee and Pat already settled up │ │  title label
│ │   with you                       │ │
│ │   Switching to Sam clears their  │ │  body
│ │   payments, and they'll be asked │ │
│ │   to pay Sam instead. Sort out   │ │
│ │   what they sent you outside the │ │
│ │   app.                           │ │
│ │   [ Switch to Sam ]   Cancel     │ │  danger, ghost
│ └──────────────────────────────────┘ │
```

### 3.3 Sheet, several people (split)

**Typing** (Sam's field focused; keyboard up; footer pinned above it):
```
┌──────────────────────────────────────┐
│ Who paid?                    $100.21 │
│ ┌────────────────┬─────────────────┐ │
│ │  One person    │▓ Several people▓│ │
│ └────────────────┴─────────────────┘ │
│ (HN) You                [$    60.00] │  field 128 wide, numeric, tabular
│ (SM) Sam                [$        |] │  focused: 2 pt focus border
│ (DE) Dee                [$         ] │  (scrolls under the footer if needed)
├──────────────────────────────────────┤  hairline divider
│ $40.21 left to assign                │  StatusLine muted, label 15/600
│ Add the rest ($40.21) to Sam         │  TextLink, 44 tall
│ [ Cancel ] [▓▓▓▓▓▓▓ Save ▓▓▓▓▓▓▓▓▓▓] │  ghost + primary (disabled, 0.5)
╞══════════════ keyboard ══════════════╡
```

**Adds up:**
```
├──────────────────────────────────────┤
│ ✓ Adds up to $100.21                 │  success
│ [ Cancel ] [▓▓▓▓▓▓▓ Save ▓▓▓▓▓▓▓▓▓▓] │  enabled
```
Spoken after the pause: `Adds up to $100.21. You can save now.`

**Over, and an invalid field:**
```
│ (SM) Sam                [$  40.2.1 ] │  2 pt danger border
│      Enter an amount like 12.50      │  caption danger, under the row
├──────────────────────────────────────┤
│ ⊘ Fix the amount marked above        │  error tone
```
```
├──────────────────────────────────────┤
│ ▲ $3.00 more than the total          │  warning tone
```

**Opened stale** (S6):
```
│ Who paid?                    $103.21 │
│ [  One person  |▓ Several people ▓]  │
│ ┌──────────────────────────────────┐ │  info Banner (surfaceMuted)
│ │ ⓘ The bill total changed to      │ │
│ │   $103.21. Update the amounts so │ │
│ │   they add up.                   │ │
│ └──────────────────────────────────┘ │
│ (HN) You                [$    60.00] │
│ (SM) Sam                [$    40.21] │
├──────────────────────────────────────┤
│ $3.00 left to assign                 │
│ Add the rest ($3.00) to you          │
│ [ Cancel ] [▓▓▓▓▓▓▓ Save ▓▓▓▓▓▓▓▓▓▓] │
```

**K > 0 confirm, and discard** (both replace the Save row in the footer):
```
├──────────────────────────────────────┤       ├──────────────────────────────────────┤
│ ▲ Pat already settled up with Sam    │       │ ▲ Discard your changes to who paid?  │
│   Saving takes Sam off who paid, so  │       │   [ Discard ]   Keep editing         │
│   Pat's payment is cleared and Pat   │       └──────────────────────────────────────┘
│   will be asked to pay again. Sort   │
│   out what Pat sent Sam outside the  │
│   app.                               │
│   [ Save and clear ]   Cancel        │
└──────────────────────────────────────┘
```

### 3.4 Settle with two payers (on top of Sent via Venmo)

**Dee (didn't pay):**
```
Settle up                                  title
Paid by Hana $60.00 and Sam $40.21         body textMuted (no action)

┌──────────────────────────────────────┐
│ You owe Hana                         │  label
│ $33.40                               │  display 32/700
│ Hana and Sam split the paying.       │  caption textMuted (S5)
│ Paying Hana covers your share.       │
│ ┌─────────┬───────┐                  │  SV chooser, hug
│ │▓ Venmo ▓│ Cash  │                  │
│ └─────────┴───────┘                  │
│ [▓▓▓▓ Pay Hana $33.40 on Venmo ▓▓▓▓] │  primary (the only one)
│ @hana-1 · $33.40                     │
│ Paid another way                     │  ghost
└──────────────────────────────────────┘

Everyone
┌──────────────────────────────────────┐
│ Paying Hana                          │  section 13/600 textMuted (S4)
│ You             $33.40       Not yet │
│──────────────────────────────────────│
│ Paying Sam                           │
│ Hana             $6.81       Not yet │
└──────────────────────────────────────┘
```
(The section label `Paying Hana` says "who" in Dee's terms. Text inside a group never repeats the recipient.)

**Hana (host, paid $60.00, owes Sam the difference):**
```
Settle up
Paid by you $60.00 and Sam $40.21 · Change     the line (host), replaces PayerPicker
You paid $60.00 · your share is $33.41         body textMuted (S5)

┌──────────────────────────────────────┐
│ You owe Sam                          │
│ $6.81                                │
│ [▓ Venmo ▓| Cash ]                   │
│ [▓▓▓▓▓ Pay Sam $6.81 on Venmo ▓▓▓▓▓] │  primary
│ @sam-2 · $6.81                       │
│ Paid another way                     │
└──────────────────────────────────────┘

Everyone
┌──────────────────────────────────────┐
│ Paying you                           │
│ Dee             $33.40       Not yet │
│ @dee-3                       Request │  ghost (unchanged rule)
│──────────────────────────────────────│
│ Paying Sam                           │
│ You              $6.81       Not yet │
└──────────────────────────────────────┘
```

**Three payers, you owe two people (T5; M9):**
```
You owe 2 people · $30.00                      section textMuted
┌──────────────────────────────────────┐
│ You owe Sam                          │
│ $20.00                               │
│ [▓ Venmo ▓| Cash ]                   │
│ [▓▓▓▓ Pay Sam $20.00 on Venmo ▓▓▓▓▓] │  primary: the first unmarked card
│ Paid another way                     │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ You owe Eve                          │
│ $10.00                               │
│ [▓ Venmo ▓| Cash ]                   │
│ [   Pay Eve $10.00 on Venmo        ] │  secondary until Sam's is marked
│ Paid another way                     │
└──────────────────────────────────────┘
```
Bill footer: `[▓ Settle up ▓]  You owe 2 people · $30.00`.

**Stale, host / others** (S6):
```
┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ ▲ Who paid doesn't match the bill    │   │ ▲ Who paid doesn't match the bill    │
│   total                              │   │   total                              │
│ $100.21 of $103.21 is assigned.      │   │ $100.21 of $103.21 is assigned.      │
│ [▓▓▓▓▓▓▓▓ Fix who paid ▓▓▓▓▓▓▓▓▓▓▓] │   │ Hana needs to update it before       │
└──────────────────────────────────────┘   │ anyone can settle up.                │
                                           └──────────────────────────────────────┘
```

---

## 4. The hard states, judged

| State | Spec | Verdict and amendment |
|---|---|---|
| Total changed after splitting (WP-9) | Settling blocked; host fixes | **Right call for UX too.** A silent re-balance would ask someone for money they don't owe. The fix is cheap once the sheet opens stale with `Add the rest ($3.00) to you` (S6). Prevention: C5 |
| A payer leaving (WP-15) | Refused, with copy | Good rule. Say it **before** the tap (S12) |
| A co-payer's account deleted (WP-16) | Back to the host, marks cleared, actor-null event | The line just changes. Acceptable for a rare admin path. Activity copy `Who paid went back to Hana` is fine |
| Someone already marked paid when the payer changes (WP-7) | Confirm, then clear | The confirm copy needs rewriting (M8). **The bigger gap: the cleared people aren't told** (U4). Dee sent Hana $33.40 on Venmo. After the switch her card says `You owe Sam $33.40` with no reason, which is the double-payment trap Sent via Venmo's "Check Venmo before paying again" exists to prevent. Proposal: a warning line on Dee's card in the SV not-received slot, `Who paid changed to Sam, so your $33.40 to Hana was cleared. Check with Hana before paying again.` It needs `payers_changed` details to list the cleared user ids (today only a count), so it's a data change. Needs the user's decision |
| Amounts changed after people marked (K = 0) | Note, then contract D difference cards | Fine. Note copy in M8 |
| Someone left while the sheet was open | `not_participant` banner, refetch | Fine. In split mode the copy goes in the footer slot (S8). If the leaver had typed amounts, the gap changes on refetch, and the status line says so |
| Saving | Spinner; nothing dismisses | Fine; also block swipe (M7) |

## 5. Screen reader walkthrough (after amendments)

1. Bill header: `Paid by you. Change who paid, button. Opens who paid.` (D6's label, with `Change` replacing `Edit`).
2. Sheet opens; focus on the heading: `Who paid? Bill total $100.21, heading.`
3. `How many people paid, radio group. One person, radio, checked, 1 of 2.`
4. One person rows: `You, radio, checked.` / `Sam, radio.` A double tap on Sam: `busy`, then the sheet closes; focus lands on the line, and iOS says `Paid by Sam`.
5. Split: `Several people, radio, checked.` Focus moves to `Amount you paid, text field, Leave blank if they didn't pay.` Typing echoes the digits. After a 700 ms pause: `$40.21 left to assign`.
6. `Amount Sam paid`. In the footer: `Add the rest, $40.21, to Sam, button. Sets Sam's amount to $40.21.` Activating it: `Adds up to $100.21. You can save now.`
7. `Save, button.` (when disabled: `dimmed. Amounts must add up to $100.21 first.`)
8. Settle cards: `Pay Hana $33.40 on Venmo, to @hana-1` and `Pay Eve $10.00 on Venmo, to @eve-5`. No two cards share a label (D12 kept).

## 6. Dark mode, targets, small phones, motion

**Contrast, every pair this design adds** (WCAG 2.x, computed from `lib/theme.ts`):

| Pair | Where | Light | Dark | Needs |
|---|---|---|---|---|
| `textMuted` / `background` | the line on the bill and Settle headers | 6.87 | 8.87 | 4.5 |
| `primary` / `background` | `Change` / `Fix` in the line | 4.97 | 10.32 | 4.5 |
| `warning` / `background` | stale line text and icon | 6.83 | 12.43 | 4.5 |
| `textMuted` / `surface` | muted status, hints, `Paying Hana` labels | 7.56 | 7.98 | 4.5 |
| `warning` / `surface` | over status, Settle stale title | 7.52 | 11.18 | 4.5 |
| `success` / `surface` | `Adds up to …` | 5.69 | 10.69 | 4.5 |
| `danger` / `surface` | field error caption, error status | 6.57 | 8.91 | 4.5 |
| `border` / `surface` | amount field outline | 3.74 | 3.75 | 3 |
| `primary` / `surfaceMuted` | selected segment vs track | 4.92 | 8.20 | 3 |
| `onPrimary` / `primary` | selected segment label, Save | 5.47 | 9.18 | 4.5 |
| `text` / `warningSurface` | confirm banners | 17.00 | 13.41 | 4.5 |
| `danger` / `dangerSurface` | `Switch to Sam`, `Save and clear`, `Discard` | 6.05 | 8.24 | 4.5 |

Known and app-wide, not new: the tonal danger button on a warning Banner is 1.04 / 1.08 against it (SV P3). The label carries it.

**Targets:** the line is 44 tall (no slop, see 3.1); rows are 56; segments 44 via the existing slop; fields 44; the TextLink is 44 × ≥ 44; footer buttons 44. Android's 48 dp guidance: rows and the line clear it; segments and buttons are 44, the app-wide standard. Not changed here.

**Small phones and large text:** the M1 budget gives about 2 visible rows with the keyboard up at 375 × 667. Split rows stack at the largest sizes (S1). Status and TextLink wrap (`flexShrink`). The footer grows upward and never clips. The bill line wraps into 2–3 lines; nothing truncates amounts (D12 kept).

**Motion:** nothing animates except the system sheet presentation (Reduce Motion is the platform's). There's no transition when the status changes tone, when Save enables, or when "Add the rest" appears. These are direct feedback and fire on every keystroke (emil: high-frequency means no animation). No haptics.

## 7. How this sits on Sent via Venmo

- The Settle shell stays as their brief §2 says: back, title, **payer line + Change**, banner slot, card(s), Everyone. Using "Change" (M1 in §2's naming, U1) keeps their wording.
- Card anatomy is unchanged. The S5 line goes in their "status lines" slot (under the amount, above the chooser); stale and cleared warnings go first in that slot, as their not-received line does.
- One primary per screen now spans cards (M9). The chooser shows on each owes card, with one remembered method.
- Footer: their Pay and Cash footer kinds apply only when you owe **exactly one** transfer. With two or more, it's primary `Settle up` + caption (M9). Their check-in footer applies per transfer; with two sends pending, the footer shows the first, and Settle shows each card's own inline question.
- Vocabulary: "settled up" for counts and confirms (M8); "Sent via Venmo" / "Paid in cash" on rows, unchanged.
- Everyone grouping (S4) keeps their row anatomy, 120 pt status column and `Not received` link exactly. It adds section labels only when there are two or more recipients.

## 8. Decisions for the user

| # | Question | Recommendation | Alternative |
|---|---|---|---|
| U1 | The line's action word | `Change` (`Paid by you · Change`): `Edit items` sits right below it, and Settle and the Sent-via-Venmo shell already say Change for this action | `Edit`, as in your decision text |
| U2 | `Paid by you` or `Paid by You` | Lower case mid-sentence; `You` only at a sentence start | Capital, as in your decision text |
| U3 | Sheet segment labels | `One person` / `Several people` ("split" already means item and tax splits) | `One person` / `Split the paying` |
| U4 | Tell people whose "paid" was cleared by a payer change | Yes: a warning line on their card (§4). Needs the event to list who was cleared | Activity only (the spec today) |
| U5 | Amounts in the line | Keep them (`Paid by you $60.00 and Sam $40.21`) | Names only, amounts in the sheet (C1) |
| U6 | Two "You owe" cards | Only the first unmarked card's button is filled; the next becomes primary once the first is marked (M9) | Both filled (breaks the one-primary rule) |
| U7 | Bill footer when you owe 2+ people | Primary `Settle up`, caption `You owe 2 people · $30.00` | Secondary, as WP-19 says |
| WP-4 | Who pays whom | UX view: **keep the spec's rule.** One link for every non-payer is what makes several payers usable at all. One extra payer-to-payer payment, now and then, is invisible to everyone else | Fewest-payments greedy (some people get two links and can be re-routed after paying) |
| WP-7 | Clearing marks on a payer change | UX view: keep the confirm, with M8's copy **and** U4. Locking is simpler but blocks a common fix (scanning, setting the wrong payer, someone pays early) | Lock who paid once anyone has marked |
| WP-9 | Total edited after a split | UX view: keep blocking. With S6, fixing it takes two taps (`Fix`, `Add the rest`, `Save`) | Auto-adjust the lead |

## 9. Not verified

None of this is built, so I couldn't see any of it. Widths are estimates for the system font: the 128 pt field, about 117 pt for `Dee pays Hana` against the 120 pt status column, about 150 pt per stretched segment, and the 340 pt keyboard budget on a 375 × 667 phone. Check on a real iPhone, an Android phone and phone Safari once Task 9 builds:
- that the footer rides the keyboard inside each platform's `Modal`;
- the web blur race (M2);
- `announceForAccessibility` on Android and the web live region (M4, R4);
- `setAccessibilityFocus` returning to the line after the sheet closes (M10);
- that blocking the iOS swipe while dirty feels like a gentle rubber-band and not a bug;
- the stale line in dark mode on `background`.

Questions skipped: delegated review; the decisions for the user are in §8.
