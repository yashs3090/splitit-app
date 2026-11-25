# App-wide visual pass: audit and direction

Date: 2026-11-25. Author: visual-designer (read-only audit; no code changed).
Asked for: every page calm, clean and polished, "not over the top", with the scan page given the most care.
In flux while this was written: `app/(app)/scan.tsx` + `components/ChoiceCard.tsx` (scan redesign, `docs/specs/2026-11-25-scan-screen-redesign.md`) and the bill screen footer (`app/(app)/bills/[id]/index.tsx`, `components/SettleFooter.tsx`). Both were audited as they are on disk now. Tasks that touch them wait (see §3).

Nothing here changes behavior, copy meaning, navigation, data flow, money math or accessibility semantics. Anything that would is in §4.

---

## 1. Visual direction

**The look.** It should feel like a quiet receipt on a clean table. Calm grey canvas, white surfaces, one teal accent, black text. Each screen has one obvious thing to do. Hierarchy comes from type size, weight and spacing. Boxes and color come last. Outlines mean "you can type here" (inputs) and nothing else. A shadow means "this whole surface is tappable" (the scan choice cards) and nothing else.

**Type ramp (`type` in `lib/theme.ts`).** Use the six steps already there. Every text style is one of them:
- `display` 32/700: only one big number per screen (Settle "You owe $X") and the home wordmark.
- `title` 22/700: the screen title, once per screen, plus the sticky-footer total.
- `headline` 17/600: card and sheet titles, choice titles. Today `Card` and `AddedNotice` write this by hand as `type.label` + `fontSize: 17`.
- `body` 16: rows, sentences, inputs.
- `label` 15/600: buttons, the "Your share" line.
- `caption` 13: status lines, hints, footnotes.
- Add **`type.section`**, 13/18/600 in `textMuted`, for a section label above a group ("Discounts", Activity's "Just now"). Two screens draw it two different ways today.
- Add **`type.micro`**, 11/13/700, for avatar initials and "+N". Today these are raw `fontSize: 10` and `12`.
- Money is always `MoneyText` (tabular numbers). It stays the largest text in its row.

**Spacing rhythm (`space`).** Each kind of gap gets one step. Today almost every screen stacks everything at `space.lg` (16), so sections are as close together as rows ("16-Everything").
| Relationship | Step |
|---|---|
| Label to its value, title to its subtitle | `xs` 4 |
| Things inside one row or one control group | `sm` 8 |
| Rows and elements inside a card | `md` 12 |
| Screen edge padding, card padding | `lg` 16 |
| Between sections/cards on a screen | `xl` 24 |
| Above a footer-level action (Sign out, Leave) | `xxl` 32 |

The screen edge is `lg` on every screen. Today home, profile and scan use `xl` and the rest use `lg`.

**Radius.** `sm` 8 for inputs, chips and segments. `md` 12 for buttons and banners. `lg` 16 for cards and sheets. `pill` for avatars, the claim toggle and status pills. Every non-pill radius also gets `borderCurve: 'continuous'` (today only `ChoiceCard` has it, 1 of 23 radius uses). A nested radius (a segment inside a track) is `radius.sm - 2` today in two files. Make it a named token, `radius.inner: 6`.

**Surfaces: grouped lists, not stacks of cards.** A screen is a column of *sections*. A section is an optional `SectionHeader` (`type.section`) over one `Card` that holds rows separated by hairlines (`StyleSheet.hairlineWidth`, `divider`). Activity already does this and is the reference. Cards get a hairline `divider` border, no shadow, `radius.lg` continuous. Things that are not a group of rows should not sit in a card: a lone sentence, a lone button, or a prompt. Use plain text on the canvas, or a `Banner` for a status. Row separators are hairlines, never `borderTopWidth: 1`.

**Icons.** One family: `lucide-react-native` (already installed, 1.80.0, used only on scan today). Outline icons. Sizes `16` (inline with caption), `20` (inline with body, icon buttons, banners) and `24` (choice badges). One stroke, `1.75`, matching `ChoiceCard`. If 16 px looks faint on device, use 2 at that size only. Icons inherit the color of their text. Decorative icons are hidden from screen readers. Icon-only controls carry an `accessibilityLabel`. They replace every text glyph used as an icon today (§2, about 25 places): `‹ ›` → `ChevronLeft/Right`, `▾ ▴` → `ChevronDown/Up`, `✕` → `X`, `+` → `Plus`, `✓` → `Check`, `⚠` → `TriangleAlert`, `ℹ` → `Info`, `◉ ○` → `CircleDot/Circle`, `− +` (stepper) → `Minus/Plus`. On iOS, `⚠` and `ℹ` can render as color emoji, which is the "Emoji Iconography" tell.

**Color.** Teal (`primary`) is for the one primary button, "mine/selected" states and text links. It is not for every outline and pill. Secondary buttons become **tonal**: `primarySurface` fill, `primary` text, no border. Danger becomes `dangerSurface` fill, `danger` text, no border. The grey `border` token (`#7B8592` / `#6B7684`) is kept for inputs only, where WCAG needs the 3:1 boundary. Status is never color alone: always icon + words. No new hues.

**Motion.** None beyond what exists: pressed feedback (opacity `0.7`, or a `surfaceMuted` background on full-width rows) and the item sheet's slide. No entrance animations. Add `motion` tokens only when the first animation needs one.

### Token additions (all additive, safe to land first)
| Token | Value | Why |
|---|---|---|
| `type.section` | 13/18, 600 | One look for section labels (now `label`+muted in bill, `caption`+600 in Activity) |
| `type.micro` | 11/13, 700 | Avatar initials and "+N" (raw `fontSize` 10 and 12 today) |
| `radius.inner` | 6 | Segment inside a track (`radius.sm - 2` twice) |
| `layout` | `{ content: 560, form: 640, message: 360, screenPadding: space.lg }` | Column widths are literals in 12 places with three values (480/560/640). Home and profile use 480. Pick 560 for all reading screens |
| `ROW_MIN_HEIGHT` | 56 | Person rows (`minHeight: 56` twice) |
| `iconSize` | `{ sm: 16, md: 20, lg: 24 }` and `ICON_STROKE = 1.75` | `ChoiceCard` builds icon sizes from spacing tokens (`space.xxl + space.lg`) |
| `opacity` | `{ pressed: 0.7, disabled: 0.5 }` | `0.7` pressed is repeated in 9 files. Disabled is `0.5` in some places and `0.4` in others |

No new colors. Contrast of the pairs the new direction relies on (computed, WCAG):
| Pair | Light | Dark |
|---|---|---|
| `primary` on `primarySurface` (tonal button, "New" pill) | 4.84 | 7.80 |
| `danger` on `dangerSurface` (tonal danger) | 6.05 | 8.24 |
| `warning` on `warningSurface` / `success` on `successSurface` | 7.21 / 5.40 | 9.54 / 9.48 |
| `textMuted` on `surfaceMuted` (info banner, muted pill) | 6.79 | 7.04 |
| `primary` on `surface` / `background` (links, icons) | 5.47 / 4.97 | 9.29 / 10.32 |
| `border` on `surface` (inputs, kept) | 3.74 | 3.75 |
| `divider` on `surface` (decorative hairline only) | 1.24 | 1.33 |
All text pairs pass 4.5:1. `divider` is never the only thing that marks a control.

### `components/ui` primitives to add or adjust
- **`Icon`**: a thin wrapper over a lucide icon that applies `iconSize`, `ICON_STROKE` and the color, and hides itself from screen readers.
- **`IconButton`** (new, promoted from `BillForm`'s local one): 44×44, `accessibilityLabel` required, optional `tone` (`neutral`/`danger`), pressed background, web focus ring. Used for delete-row, copy link, the Profile entry (if §4 P4 is accepted) and the stepper.
- **`TextLink`** (promoted from `BillForm`): a quiet text action with a 44-pt target ("+ Add note", "Tip options").
- **`TopBar`**: the back row every pushed screen hand-builds: `ChevronLeft` + label, flush to the column edge, optional right-side action. It replaces 6 copies of `Button variant="ghost" label="‹ …" style={edgeButton}`.
- **`SectionHeader`**: `type.section` text with `accessibilityRole="header"`.
- **`ListRow`**: leading slot (avatar/icon), title + optional caption, trailing slot (money/button/chevron), hairline between rows, `ROW_MIN_HEIGHT`, a pressed background when tappable. It replaces the hand-built rows in home, people, PeopleList, Activity and SettlePeopleList.
- **`SegmentedControl`**: the "track with 2-pt inset segments" that `BillForm` (before/after subtotal) and `TipOptions` (% / $) each build by hand.
- **`StatusLine`**: the inline "✓ Saved" / "✓ Added Sam" success line (profile, people, SharePanel's "Link copied") with a `Check` icon and a live region.
- **`Button`** (adjust): `secondary` → tonal; `danger` → tonal danger; replace the `leading` string with `icon?: LucideIcon`; add `flush` (no horizontal padding, keeps the 44 minWidth), which replaces the `edgeButton`/`ghost`/`dismiss` style overrides in 10 files; `paddingVertical: space.sm` (not `sm + 2`); `borderCurve`; a visible web focus ring like `ChoiceCard`'s.
- **`Card`** (adjust): hairline border, `borderCurve`, title in `type.headline` (drop the `fontSize: 17` override).
- **`Banner`** (adjust): lucide icon (`Info`, `TriangleAlert`, `CircleAlert`, `CircleCheck`) at 20 in place of glyphs; drop the 4-pt colored left stripe; tinted surface + `radius.md` continuous.
- **`Centered`** (adjust): paint `colors.background` and use tokens (`padding: 24, gap: 16` literals today). See the dark-mode finding below.

---

## 2. Findings

### Audit grep counts
Run on `app components lib/theme.ts` (`*.ts`/`*.tsx`, tests excluded). Spacing whitelist is this project's scale (0, 4, 8, 12, 16, 24, 32). 6,512 source lines.
| Check | Hits | Per 100 lines | Where |
|---|---|---|---|
| Hardcoded hex outside theme | 3 | 0.05 | all in `app/(auth)/sign-in.tsx` (`#1a73e8`, `#fff`, `#b3261e`) |
| Raw `fontSize` | 9 | 0.14 | sign-in ×2, `Banner`, `Card`, `Button`, `AddedNotice`, `Avatars` ×2, `PayerPicker` |
| Off-scale spacing literals | 6 | 0.09 | `paddingVertical: 2` (home pill), `gap: 2` (SharesSummary), Avatars `2` / `-6`, segmented `padding: 2, gap: 2` ×2 |
| On-scale literals not using tokens | 2 | 0.03 | sign-in (`20`, `12`), `Centered` (`24`, `16`) |
| Token arithmetic (`space.x ± n`) | 3 | 0.05 | `Button` `sm + 2`, `TextField` `md - 1` (justified: focus ring), `BillForm` pill `xs + 2` |
| Raw `borderRadius` | 1 (+2 `radius.sm - 2`) | 0.05 | sign-in; BillForm, TipOptions |
| Radius without `borderCurve: 'continuous'` | 22 of 23 | 0.34 | everywhere except `ChoiceCard` |
| Legacy shadow props | 0 | 0 | (one `boxShadow` token use, `ChoiceCard`) |
| Files with `<Pressable>` and no a11y role/label | 0 (18 Pressables) | 0 | (sign-in's Pressable has a role but no pressed state) |
| `TouchableOpacity` / `fontFamily` / `Alert.alert` / gradients | 0 | 0 | |
| `<Modal>` | 1 | | `ItemSheet` (custom bottom sheet) |
| `headerShown: false` | 3 | | every stack, so every screen hand-rolls its header |
| Text glyphs used as icons | ~25 in `app`/`components` + 8 in `lib/settleView.ts` copy | 0.5 | `‹ › ▾ ▴ ◉ ○ ✕ ✓ ⚠ ℹ +` |
| Decorative 1-px borders (not hairline) | 6 | | BillForm row separators ×2, totals row, both sticky footers, status pill |
| Layout literals (column widths, row heights) | 14 | | 480/560/640/360/320, `minHeight: 56` ×2, `minWidth: 84/64/52/72/96` |

The token scores are all "healthy" (< 0.5). The theme is used. The drift is in the *look*: glyph icons, outline-everything buttons, everything in cards, uneven section spacing, and screens outside the theme in dark mode.

### App-wide issues (fix once in the system)
1. **Dark mode breaks on every `Centered` screen.** No navigator theme or `contentStyle` is set, so the stack's card background is React Navigation's light default. `Centered` paints no background. Sign-in, the OAuth callback, the invite screen, and every Loading / "not found" / "Couldn't load" state show a light grey page with default-black text in dark mode. Screens that are otherwise dark flash light while loading ("Dark-Mode Amnesia" + "Spinner Blink"). Fix: `Centered` paints `colors.background`, and the three stack layouts set `contentStyle: { backgroundColor: colors.background }`. The un-themed `<Text>`/`<Link>` in sign-in, callback and invite get theme colors.
2. **Hand-rolled headers.** `headerShown: false` everywhere. Each pushed screen draws its own ghost "‹ Back/Bill/Home" button (6 copies, 3 labels, primary-teal text). The iOS back-swipe still works. The fix within visual scope is a `TopBar` primitive. Moving to native headers is proposal P1.
3. **Outline-everything buttons.** `secondary` is a white button with a 3.7:1 grey outline. Home, SharePanel, People, AddedNotice, VenmoPrompt and Profile each show 2–4 of them, which looks like a wireframe. Making `secondary` tonal removes most of the outlines on screen at once.
4. **Everything's a card.** Home is three stacked cards. Lone prompts (VenmoPrompt, AddedNotice, Settle's Venmo prompt) are cards. ContactInvite's `surfaceMuted` panel sits inside SharePanel's card (card in card).
5. **Section spacing equals row spacing.** Column `gap: space.lg` on every screen, and card inner gap `md`. Sections should be `xl` apart.
6. **Glyph icons** (list above). `Banner`'s `⚠`/`ℹ` are the most visible.
7. **Section headers drawn two ways** (`type.label` muted on the bill screen, `caption` + 600 in Activity).
8. **Web focus ring** exists only on `ChoiceCard`. `Button`, rows and toggles rely on the browser's default ring, and `TextField` removes it on purpose (it draws its own).

### Per-screen (worst first)

**1. Sign-in** (`app/(auth)/sign-in.tsx`), plus **callback** (`app/auth/callback.tsx`) and **invite** (`app/b/[code].tsx`)
- Goal: one tap, "Continue with Google". Focal point: the button. That part is correct.
- It is the only screen outside the theme: 3 hex colors, 2 raw font sizes, raw radius and padding, a Google-blue button that matches nothing else, no pressed state (busy only), and Text with no color. In dark mode it is a light page with black text (app-wide issue 1). The title is `fontSize: 28`, which is not on the ramp.
- Callback and invite: bare `<Text>` and an unstyled `<Link>` ("Back to sign-in", "Go home") that look like web defaults. Invite already uses `Button` for its join errors but not for its invalid-link state.
- Changes: `display` wordmark "SplitIt", a `body` muted line, `Button variant="primary" block` (same label, same busy copy), the error as `Banner tone="error"`, everything in a 360-wide centered column on `colors.background`. Callback/invite: themed text, and `Button variant="ghost"` in place of bare `Link`s (same labels and destinations). Google button branding is P5.

**2. Bill / claim** (`app/(app)/bills/[id]/index.tsx`, `ClaimItemRow`, `SharesSummary`, `SharePanel`, `ExtrasSplitControl`, `ItemSheet`, `LeaveBill`, `SettleFooter`). The footer is in flux.
- Goal: find my items, tap Claim, see my share, then settle. Focal point should be the item list, with "Your share" + one action in the footer.
- What competes: the top area has five teal text actions (‹ Home, Activity, Edit items, plus Dismiss/Refresh when shown). Every row ends in a teal-outlined "Claim" pill when unclaimed, so the right edge is a column of teal. SharePanel is the loudest block on the page: a card with an "Add people" outline button, a caption, a raw full URL in body text, 2–3 outline buttons, and "Make a new link". In the worst case the sticky footer holds a claim-error Banner, the expanded everyone list (up to 280 high), the extras control, the Settle footer and its error Banner, which can cover half a small phone.
- Inconsistencies: "Discounts" header style ≠ Activity's. `‹ Home` / `Everyone ▴` / `Hide ▾` / `✓ Mine` glyphs. Footer `borderTopWidth: 1` (others use hairline). The claim pill uses `minWidth: 84` literal. `ItemSheet` top corners have no `borderCurve`, and its stepper uses `width: 40` literal and `−`/`+` text.
- Dark mode: fine on the main view. Loading/not-found/error use `Centered` (app-wide issue 1).
- Native-slop: Everything's a Card (SharePanel + nested ContactInvite panel). Web Modal-ish custom sheet without drag-to-dismiss (P6). Hand-rolled header.
- Changes:
  - `TopBar` with `ChevronLeft` Home and a right-side "Activity".
  - Title block: `title` + `Total $X` as muted `MoneyText` on the same baseline style.
  - Claim toggle: unclaimed = `primarySurface` fill, `primary` text, no border. Claimed by others only = `surfaceMuted` fill, `text` color. Mine = `primary` fill with a `Check` icon + "Mine". Same labels, states and hints. The three states differ by text and icon, not only color.
  - SharePanel: URL on one line (`numberOfLines={1}`, `ellipsizeMode="middle"`, still selectable, same a11y label) in a `surfaceMuted` inset with a Copy `IconButton` beside it, or keep the "Copy link" button tonal. Share/Contacts tonal. "Make a new link" a quiet `TextLink`. The ContactInvite inner panel loses its fill and uses spacing instead.
  - SharesSummary: `ChevronUp/Down` icon in place of `▴/▾`. Errors in the footer become one caption line with an icon, not a full Banner (for the footer agent).
  - Sections `xl` apart.

**3. Bill form** (`bill.tsx`, `bills/[id]/edit.tsx`, `BillForm`, `TipOptions`)
- Goal: check each line against the receipt, see "Adds up", tap Save. Focal point: the footer total + status + Save. That is correct.
- What competes: a grid of grey-outlined inputs (needed), but also 1-px row separators, a bordered segmented control, bordered tip chips, a bordered status pill, and a `✕` per row. Every element has an outline, so the inputs don't read as *the* editable things. The Discounts card shows its full chrome (title, "Optional", caption, "+ Add discount") even when empty, which is a lot for the rare case.
- Inconsistencies: `borderTopWidth: 1` separators (hairline elsewhere). Status pill padding `xs + 2`. Segmented track `padding: 2, gap: 2` duplicated in TipOptions. `✓ Before subtotal` glyph-in-label. `IconButton`/`TextLink` defined locally. Card titles via the `fontSize: 17` override. `bill.tsx` has no back control (P2), while `edit.tsx` has "‹ Back" inside the form header rather than a top bar, so the two siblings differ.
- Dark mode: OK. The `Switch` track uses `border` in the off state (fine).
- Changes: hairline separators. Status pill without border, with a `CircleCheck`/`TriangleAlert`/`Ellipsis` icon. `SegmentedControl` primitive for both segmented controls (selected = `surface` fill on a `surfaceMuted` track + weight; the check glyph becomes a `Check` icon). Delete = `IconButton` with an `X` icon. "Add item" / "Add discount" with a `Plus` icon. Totals rows: "Total" is `headline` and its field `large`, as now. Edit uses `TopBar`. P2 covers a bill.tsx back control and an empty-Discounts collapse (P12).

**4. Home** (`app/(app)/index.tsx`, `AddedNotice`, `VenmoPrompt`)
- Goal: start a bill or reopen one. Focal point: "Scan receipt". It is primary, but it sits inside the second of three stacked cards, under a title and a sentence.
- What competes: the "Profile" outline button sits at the same visual weight as the wordmark, top right. The VenmoPrompt card can push "Your bills" further down.
- Inconsistencies: `maxWidth: 480` and `paddingHorizontal: xl` (other screens 560/`lg`). Row chevron `›` drawn in `type.title`. The marker pill uses `paddingVertical: 2`. Bill rows use opacity press feedback while full-width rows should get a background highlight.
- Changes: the "Split a bill" block leaves its card: a muted sentence + a full-width primary button directly under the header. "Your bills" uses `SectionHeader` + a grouped `Card` of `ListRow`s with a `ChevronRight` icon. Prompts (AddedNotice, VenmoPrompt) become quiet `Banner tone="info"`-style notices with tonal/ghost buttons, not white cards. Profile becomes a tonal button with an icon (an icon-only version is P4).

**5. Settle** (`bills/[id]/settle.tsx`, `SettleCard`, `SettlePeopleList`, `PayerPicker`)
- Goal: see what I owe, pay, mark paid. Focal point: SettleCard's `display` amount + primary Pay. That is good.
- What competes: the "Add your Venmo" card is also `primary block`, so two primary buttons can be on screen (P10). The payer line + "Change" ghost + PayerPicker card all sit in the header area.
- Inconsistencies: PayerPicker radios are `◉/○` text at raw `fontSize: 20`. `✓ Paid` / `⚠ Your share…` glyphs live in copy strings (`lib/settleView.ts`, asserted by tests → P3). The ghost "Undo"/"Request" buttons get `flush` overrides by hand. The status column uses `minWidth: 64`.
- Changes: `TopBar`. A `Radio` row in PayerPicker (`CircleDot`/`Circle` icons, pressed background). SettlePeopleList on `ListRow`. Sections `xl` apart. Confirm banners keep the tonal danger button.

**6. Scan** (`app/(app)/scan.tsx`, `ChoiceCard`). In flux: these are review notes for the product-engineer, not tasks to start now.
- Goal: get the items in, by photo or by hand. Focal point: two equal choice cards, centered. The redesign has this right: one title, one quiet line, two calm cards, no clutter. It is already the closest screen to the direction.
- Notes:
  - The card has a hairline border *and* `shadow.card`. That fits the rule "shadow = tappable surface", so keep it, and keep it the only shadowed thing in the app.
  - `BADGE = space.xxl + space.lg` / `GLYPH = space.xl` use spacing tokens as sizes. Move them to `iconSize.lg` and a `48` badge constant once the tokens exist.
  - The reading state's progress track has a 1-px `border` outline. A `surfaceMuted` track with no border is calmer. The fill is `primary` on `surfaceMuted` (4.92 / 8.20), so the bar stays visible.
  - The failure state switches from cards to two block buttons, so the screen has two visual languages (P9).
  - There is no back or close control in any state (P2). It relies on back-swipe / browser back. Every other pushed screen has a top-left back.
  - `COLUMN_MAX_WIDTH = 560` and the track's `maxWidth: 320` become `layout` tokens later.
  - The `Banner` above the choices will pick up the Banner restyle automatically.
  - Centered vertically, unlike other screens, which are top-aligned. That is deliberate per the user's request; keep it.
  - Dark mode: fine. `primary` on `primarySurface` = 7.80.

**7. Add people** (`bills/[id]/people.tsx`, `PeopleList`)
- Focal point: the list of people with "Add". Each row ends in an outline "Add" button, so the screen is a column of outlines. "Remove" is a teal ghost.
- Inconsistencies: `minHeight: 56` twice. The "✓ Added Sam" line is built by hand, the same as Profile's. `‹ Back` top bar.
- Changes: tonal `Button` with a `Plus` icon for Add (same label/hints). `ListRow`. `StatusLine`. `TopBar`.

**8. Profile** (`app/(app)/profile.tsx`)
- Calm already. The Venmo field + Save is the focal point. Sign out is a centered ghost at the bottom (good).
- Inconsistencies: `maxWidth: 480`, `paddingHorizontal: xl`, a hand-built "✓ Saved" line, `‹ Back`, and the name shown as `body` in full `text` color right under the title (reads like a second title).
- Changes: `TopBar`, `StatusLine`, name in `textMuted`, Sign out `xxl` below the last card, layout tokens.

**9. Activity** (`bills/[id]/activity.tsx`). The reference screen.
- Section label + one card of hairline rows per time group, avatar + sentence. Only nits: `‹ Bill` → `TopBar`, the section label → `SectionHeader`, the `marginTop: 1` optical nudge is commented (fine), `Centered` states dark-mode.

---

## 3. Ordered plan (one reviewable task each)

Each task is visual-only. It keeps every label, hint, `testID` and behavior, and runs `npx jest <file>`, `npm test -- --maxWorkers=4` and `npm run typecheck`.

| # | Task | Files | Can start |
|---|---|---|---|
| V1 | Tokens: `type.section`, `type.micro`, `radius.inner`, `layout`, `ROW_MIN_HEIGHT`, `iconSize`/`ICON_STROKE`, `opacity`. Additive, no screen changes | `lib/theme.ts` | Now |
| V2 | Dark-mode backgrounds: `Centered` paints `colors.background` (tokens for its padding/gap); stack layouts set `contentStyle` | `components/Centered.tsx`, `app/_layout.tsx`, `app/(app)/_layout.tsx`, `app/(auth)/_layout.tsx` | Now |
| V3 | Sign-in, callback, invite onto the theme (Button, Banner, themed text) | `app/(auth)/sign-in.tsx`, `app/auth/callback.tsx`, `app/b/[code].tsx` | Now (P5 decides the button's look; default to `primary`) |
| V4 | New primitives `Icon`, `IconButton`, `TextLink` (moved out of BillForm), `SectionHeader`, `StatusLine`. No screen adopts them yet except BillForm's moved pair | `components/ui/*`, `components/BillForm.tsx` (import only) | Now |
| V5 | `Banner` restyle: lucide icons, no stripe, `borderCurve` | `components/ui/Banner.tsx` | After the scan redesign merges (scan shows Banners; avoid moving its look mid-review) |
| V6 | `Button`: tonal secondary/danger, `icon` prop, `flush`, focus ring, `borderCurve`; then drop the `edgeButton`/`ghost`/`dismiss` overrides | `components/ui/Button.tsx` + the 10 override sites | After **both** scan and bill-footer work merge (touches `SettleFooter` and the bill screen) |
| V7 | `Card` (hairline, curve, `headline` title) + `ListRow` + `SegmentedControl` primitives | `components/ui/*` | After V4 |
| V8 | `TopBar` primitive; adopt on activity, people, profile, settle, edit | those 5 screens | After V4. Bill screen adopts it in V12 |
| V9 | Home: un-card the start block, grouped "Your bills", quiet prompts, layout tokens | `app/(app)/index.tsx`, `AddedNotice`, `VenmoPrompt` | After V6, V7 |
| V10 | Bill form: hairlines, status pill, `SegmentedControl`, icons | `components/BillForm.tsx`, `components/TipOptions.tsx` | After V7 |
| V11 | Settle: `Radio` rows in PayerPicker, `ListRow` in SettlePeopleList, spacing | `settle.tsx`, `PayerPicker`, `SettlePeopleList`, `SettleCard` | After V6, V7 |
| V12 | Bill screen body: TopBar, claim toggle states, SharePanel + ContactInvite calm-down, section spacing, discounts header | `bills/[id]/index.tsx`, `ClaimItemRow`, `SharePanel`, `ContactInvite`, `LeaveBill` | **After bill-footer work merges** |
| V13 | Bill footer: SharesSummary chevrons, compact error line, hairline top | `SharesSummary`, `ExtrasSplitControl`, `SettleFooter` | **After bill-footer work merges** |
| V14 | People + Profile: `ListRow`, tonal Add, `StatusLine`, layout tokens | `people.tsx`, `PeopleList`, `profile.tsx` | After V6, V7 |
| V15 | Item sheet + Activity nits: `borderCurve`, stepper `IconButton`s, `SectionHeader` | `ItemSheet`, `Avatars` (`type.micro`), `activity.tsx` | After V4 |
| V16 | Scan follow-ups: icon-size tokens in ChoiceCard, borderless progress track, layout tokens | `scan.tsx`, `ChoiceCard` | **After the scan redesign merges** |

V1–V4 are independent of the in-flux work and give the fastest visible win: dark mode fixed and sign-in on-brand.

---

## 4. Proposals needing a behavior or copy decision (not part of the tasks above)

- **P1 · Native stack headers.** Replace the hand-rolled top bars with `Stack` header options: system back button, title, back-swipe and web history all handled. This changes how every screen title renders and the tests that find "‹ Bill". Recommendation: do V8's `TopBar` now and revisit native headers later.
- **P2 · A way back on Scan and the new-bill form.** Neither has a visible back/close control. Both rely on swipe, Android back or browser back. Add a `TopBar` "‹ Home" on scan, and "‹ Back" on `bill.tsx` (what happens to an unsaved draft is a behavior question).
- **P3 · Glyphs in copy strings.** `lib/settleView.ts` builds "✓ Paid", "✓ Marked paid", "⚠ Your share is now…", "Marked … ⚠", "‹ Bill". Tests assert these strings. Moving the glyphs to icons changes visible copy and the `withoutGlyph` helper. Proposal: copy without glyphs plus a `tone` field the UI turns into an icon.
- **P4 · Home header.** (a) Profile as an icon-only button (`CircleUserRound`, same `accessibilityLabel` "Profile"), so the visible word goes. (b) Drop "Signed in as …", since Profile shows the name. (c) Drop the "Split a bill" heading and keep one sentence above the button.
- **P5 · Google button.** Keep our teal primary "Continue with Google", or follow Google's sign-in branding (neutral button with the G mark, needs an asset)? Today it's an off-system Google blue.
- **P6 · Item sheet as a native sheet.** `formSheet` / a sheet with drag-to-dismiss and a grab handle, replacing the custom `Modal`. Changes dismissal behavior. Adding a handle without drag would be misleading, so no handle unless this is done.
- **P7 · Brand colors in `app.json`.** The splash background (`#208AEF`) and Android adaptive-icon background (`#E6F4FE`) are the template's blues, not our teal, and there's no dark splash. Needs a dev build to verify. This is a brand choice. Add it to `docs/before-production.md` if deferred.
- **P8 · Host invite placement.** While the host is the only participant, show the invite block above the items (the host's next step), and below them once people have joined.
- **P9 · Scan failure state as choice cards.** Use the idle state's `ChoiceCard` look for "Retake photo / Type it in", so the screen keeps one visual language. The scan spec says this state is unchanged, so it's the user's call.
- **P10 · One primary on Settle.** When the "Add your Venmo" prompt and a Pay/I paid action are both on screen, which is primary? Proposal: the prompt's button goes tonal.
- **P11 · "Edit items" placement.** Move it from under the total into the top bar's right side (next to Activity, or as a menu). This changes reading order for screen readers.
- **P12 · Empty Discounts card.** Collapse it to a single "+ Add discount" `TextLink` until the first discount exists, which matches the opt-in rule for optional inputs. This changes what is visible by default.

Visual verification: none of this was seen rendered. I can't view the screens. Contrast numbers are computed from the hex tokens. Each task should be checked on a device or web in light and dark.

## User decisions on proposals (2026-11-25)
- **Approved:** P1 (native stack headers), P2 (back control on Scan and the new-bill form), P3 (icons instead of glyphs in the settle copy; update the tests that assert them), P4 (home header: Profile as an icon, drop "Signed in as"), P5 (Google button to Google's official branding), P6 (item sheet as a native sheet), P7 (splash and Android icon backgrounds in SplitIt teal), P8 (invite block first while the host is alone on the bill), P9 (scan failure state as choice cards), P10 (one primary button on Settle; the designer proposes which).
- **Rejected:** P11 ("Edit items" stays where it is), P12 (keep the Discounts card as it is).

## 5. Ordered plan after the user's decisions (updated 2026-11-25)
V1–V4 landed (uncommitted, awaiting review): tokens, dark-mode backgrounds, sign-in/callback/invite on the theme with the Google button to Google's branding (P5), and the primitives `Icon`, `IconButton`, `TextLink`, `SectionHeader`, `ListRow`, `SegmentedControl`, `StatusLine` (plus `useFocusRing`). `TopBar` was **not** built: P1 replaces it. Decisions VP-1…VP-9 are in `docs/decisions-to-review.md`.

The approved proposals fold into the plan like this. The waits from §3 still hold: nothing touches the bill screen, its footer or `ItemSheet` until the bill-footer work merges, and nothing touches scan until the scan redesign is reviewed and merged.

| # | Task | Files | Can start |
|---|---|---|---|
| V5 | `Banner` restyle (unchanged) | `components/ui/Banner.tsx` | After the scan redesign merges |
| V6 | `Button` tonal secondary/danger, `icon`, `flush`, focus ring (unchanged) | `Button.tsx` + override sites | After scan **and** bill-footer merge |
| V7 | `Card` adjust (hairline, curve, `headline` title, a `flush` option for `ListRow` groups, VP-7) | `components/ui/Card.tsx` | Now |
| **V8 (was TopBar) · P1** | Native stack headers: theme them once in the stack layouts (`headerStyle` = `background`, `headerTintColor` = `primary`, title in `headline`, no shadow/hairline), then turn `headerShown` on and set titles for activity, people, profile, settle and edit, deleting their hand-built "‹ …" rows. Tests that find "‹ Bill"/"‹ Back" switch to the header's back button. Check web (header back + browser history) and Android | `app/(app)/_layout.tsx`, those 5 screens, their tests | After V7. The bill screen adopts it in V12 |
| V9 · P4 | Home: as before, plus Profile as an icon-only `IconButton` (`CircleUserRound`, label "Profile") and "Signed in as …" removed (update `inviteFlow.test.tsx`, which asserts it) | `app/(app)/index.tsx`, `AddedNotice`, `VenmoPrompt` | After V6, V7 |
| V10 | Bill form (unchanged; BillForm switches to the `components/ui` `IconButton`/`TextLink`, VP-9). P12 rejected: Discounts card stays | `BillForm.tsx`, `TipOptions.tsx` | After V7 |
| **V10a · P2** | New-bill form gets the native header back (V8's stack options). **Open behavior question for the user:** what happens to an unsaved draft on back (keep it for next time, discard silently, or confirm)? Build after that answer | `app/(app)/bill.tsx` | After V8 + the user's answer |
| V11 · P10 · P3 | Settle: as before, plus (P10) the "Add your Venmo" prompt's button goes tonal so Pay / "I paid" stays the only primary; (P3) `lib/settleView.ts` returns copy without glyphs plus a `tone` the UI turns into an icon (`Check`, `TriangleAlert`), and `settle.test.tsx` / `lib/settleView.test.ts` drop the glyphs | `settle.tsx`, `PayerPicker`, `SettlePeopleList`, `SettleCard`, `lib/settleView.ts` + tests | After V6, V7, and after the bill-footer merges if `SettleFooter` reads `settleView` |
| V12 · P8 · P1 | Bill screen body: as before (P11 rejected: "Edit items" stays), plus native header (P1), plus (P8) the invite block above the items while the host is the only participant and below them once someone joins | `bills/[id]/index.tsx`, `ClaimItemRow`, `SharePanel`, `ContactInvite`, `LeaveBill` | After bill-footer merges |
| V13 | Bill footer (unchanged) | `SharesSummary`, `ExtrasSplitControl`, `SettleFooter` | After bill-footer merges |
| V14 | People + Profile (unchanged; their top bars go in V8) | `people.tsx`, `PeopleList`, `profile.tsx` | After V6, V7 |
| **V15 · P6** | Item sheet as a native sheet (an Expo Router `formSheet` route or a sheet with drag-to-dismiss and a grab handle), replacing the custom `Modal`; the stepper uses `IconButton`. Behavior change (dismissal): needs product-engineer, not only a visual task. Activity's `SectionHeader` and Avatars' `type.micro` stay a separate small visual task | `ItemSheet`, its route/tests; `Avatars`, `activity.tsx` | Sheet: after bill-footer merges. Activity/Avatars: now |
| V16 · P2 · P9 | Scan follow-ups (unchanged), plus (P2) the native header back on every scan state, plus (P9) the failure state's "Retake photo / Type it in" as `ChoiceCard`s | `scan.tsx`, `ChoiceCard` | After the scan redesign merges and V8 |
| **V17 · P7** | Splash background and Android adaptive-icon background in SplitIt teal, with a dark splash. Brand values to `app.json`; verify on a dev build (iOS and Android) | `app.json` | Now (needs a device check) |

### Progress (2026-11-25, later)
- Landed, uncommitted: **V7** (Card), **V8** (native headers on activity, people, profile, settle, edit; `components/ui/BackHeader`), the code-review fixes **R5–R9**, **V10** (bill form), **V10a** (back on the new-bill form, decision VP-M1), **V15** Activity/Avatars part (the item sheet, P6, still waits for the bill-footer merge), **V17** (splash/icon colors, plus R10: native root background and `public/index.html`). Decisions VP-10…VP-20 in `docs/decisions-to-review.md`.
- Still waiting: V5, V6 (scan approved; V6 still waits on the bill footer), V9, V11, V12, V13, V14, V15's sheet, V16 (with review notes R1–R4).
- **P13 (new, needs the user):** the new-bill form's "Discard this bill?" check runs only for the visible Back control. The iOS back-swipe, Android back button and browser back still leave without asking, as they did before. Intercepting them (`usePreventRemove`) would turn the back-swipe off on this screen while something is entered, and browser back can't be fully stopped. Keep as is, or intercept on native only?
- Later still: **V5** (Banner), **V16** (scan: P2 Home back, P9 failure cards, review R1–R4), **V6 first part** (Button `icon`/`flush`/focus ring/curves; tonal colors and the override clean-up wait for the bill-screen files and `billScreen.test.tsx`), **V9** (Home, P4), **V14** (People, Profile). Decisions VP-21…VP-28. Still waiting on the Request/Pay review: V6's second part, V11, V12, V13, the P6 item sheet.
- Then: **V6 rest** (tonal buttons, overrides → `flush`), **V11** (Settle: P3 no-glyph copy, P10, payer radios), **V12** (bill screen: native bar, P8, claim toggle, SharePanel), **V13** (footer). Decisions VP-29…VP-34. Remaining: **P6** (item sheet as a native sheet).
- Last: review fixes **R3–R6, R9, R10** in the files still mine (R1, R2, R7, R8 and the R10 comment are with splitit-app-92), and **P6**: on iOS the item sheet is the system page sheet with swipe-down to close; Android and web keep the scrim sheet (VP-37, VP-38). The visual pass's own task list is complete.
