---
name: SplitIt
description: Split an itemized bill fairly, to the cent, at the table.
colors:
  settle-teal: "#0F766E"
  settle-teal-dark: "#2DD4BF"
  on-settle-teal: "#FFFFFF"
  on-settle-teal-dark: "#04201D"
  teal-wash: "#E6F4F2"
  teal-wash-dark: "#0F2E2B"
  focus: "#0F766E"
  focus-dark: "#5EEAD4"
  table-grey: "#F3F4F6"
  table-grey-dark: "#0B0F14"
  receipt-paper: "#FFFFFF"
  receipt-paper-dark: "#161B22"
  paper-muted: "#F1F3F5"
  paper-muted-dark: "#1F262F"
  ink: "#111827"
  ink-dark: "#F3F4F6"
  ink-muted: "#4B5563"
  ink-muted-dark: "#A8B1BD"
  control-border: "#7B8592"
  control-border-dark: "#6B7684"
  hairline: "#E5E7EB"
  hairline-dark: "#2A323C"
  danger: "#B42318"
  danger-dark: "#FDA29B"
  danger-wash: "#FEF3F2"
  danger-wash-dark: "#3A1714"
  success: "#067647"
  success-dark: "#75E0A7"
  success-wash: "#ECFDF3"
  success-wash-dark: "#0F2A1D"
  warning: "#93370D"
  warning-dark: "#FEC84B"
  warning-wash: "#FFFAEB"
  warning-wash-dark: "#33260B"
typography:
  display:
    fontFamily: "System (SF Pro on iOS, Roboto on Android, system-ui on web)"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: "38px"
  title:
    fontFamily: "System"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: "28px"
  headline:
    fontFamily: "System"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "System"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: "System"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
  section:
    fontFamily: "System"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "18px"
  caption:
    fontFamily: "System"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  micro:
    fontFamily: "System"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: "13px"
rounded:
  inner: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.settle-teal}"
    textColor: "{colors.on-settle-teal}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.teal-wash}"
    textColor: "{colors.settle-teal}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "44px"
  button-ghost:
    textColor: "{colors.settle-teal}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "44px"
  card:
    backgroundColor: "{colors.receipt-paper}"
    rounded: "{rounded.lg}"
    padding: "16px"
  card-muted:
    backgroundColor: "{colors.paper-muted}"
    rounded: "{rounded.lg}"
    padding: "16px"
  text-field:
    backgroundColor: "{colors.receipt-paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "44px"
  segmented-track:
    backgroundColor: "{colors.paper-muted}"
    rounded: "{rounded.sm}"
  segmented-selected:
    backgroundColor: "{colors.settle-teal}"
    textColor: "{colors.on-settle-teal}"
    typography: "{typography.label}"
    rounded: "{rounded.inner}"
  list-row:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "12px 16px"
    height: "56px"
  icon-button:
    rounded: "{rounded.pill}"
    size: "44px"
---

<!-- Source of truth for every value above: lib/theme.ts (tokens) and components/ui/ (primitives).
     When a token changes there, update this file in the same task, and the other way round. -->

# Design System: SplitIt

## Overview

**Creative North Star: "The Quiet Receipt at a Calm Table"**

SplitIt should feel like a clean, honest receipt laid on a calm table. The receipt part: plain paper surfaces, figures that line up in tabular columns, and the money as the loudest thing on screen. The calm table part: the app is used one-handed, in dim light, with friends waiting, so every screen has generous space, one obvious next step, and nothing that competes for attention. The honest ledger runs underneath: every number is accounted for, and any status (unclaimed, doesn't add up, self-reported "paid") is said in words, never in colour alone.

Density is moderate: comfortable rows (56 px minimum with an avatar), a 16 px screen edge, and reading columns held to 560 px so the layout stays phone-shaped even on a wide browser. Ambition shows as precision and restraint: consistent radii with continuous corners, one icon stroke, aligned figures, finished pressed and focus states. The user's brief is explicit: clean and pretty, "not over the top".

**Key Characteristics:**
- Flat surfaces grouped by tone and hairlines, not shadows.
- One Settle Teal voice for the next step; everything else is ink and paper.
- Money set in tabular numerals, right-aligned, the bill total the largest figure.
- Light and dark are equal citizens; every text pair is 4.5:1 or better in both.
- Platform-native system type (SF Pro, Roboto, system-ui), sized by a fixed 8-step scale.

## Colors

A cool, near-neutral paper-and-ink palette with a single teal accent and three quiet status colours, each paired with a pale wash.

### Primary
- **Settle Teal** (light `settle-teal`, dark `settle-teal-dark`): the next step. Filled primary buttons, the selected segment, links and ghost buttons, and keyboard focus. In dark mode it brightens to stay readable on near-black.
- **Teal Wash** (`teal-wash` / `teal-wash-dark`): the background of secondary buttons and "this is yours / selected" surfaces. It carries Settle Teal text.

### Neutral
- **Table Grey** (`table-grey` / `table-grey-dark`): the screen background behind cards.
- **Receipt Paper** (`receipt-paper` / `receipt-paper-dark`): cards, inputs and sheets.
- **Muted Paper** (`paper-muted` / `paper-muted-dark`): quiet cards, segmented-control tracks, pressed rows, subtle inputs, info banners.
- **Ink** (`ink` / `ink-dark`): all primary text and money.
- **Muted Ink** (`ink-muted` / `ink-muted-dark`): captions, field labels, section labels, secondary figures.
- **Control Border** (`control-border` / `control-border-dark`): input and control outlines, kept at 3:1 or better against paper.
- **Hairline** (`hairline` / `hairline-dark`): decorative row dividers and card edges. Never the only thing that conveys meaning.

### Status
- **Danger** with **Danger Wash**: errors and destructive actions (Leave bill, Remove).
- **Success** with **Success Wash**: paid, settled, all items claimed.
- **Warning** with **Warning Wash**: totals that don't add up, unchecked amounts.
- The scrim behind sheets is ink at 45% (light) and black at 60% (dark).

### Named Rules
**The One Voice Rule.** Settle Teal is the only accent colour. It marks the next step and what's selected. Never give a screen its own accent, and never use teal for decoration.

**The Said-Not-Shaded Rule.** Every status colour comes with an icon or words ("Doesn't add up by $0.02"). Error and warning icons also differ in shape (circle vs triangle), so they read without colour.

**The Brand-Is-Theirs Rule.** Google's sign-in button uses Google's own colours (`googleButtonColors` in `lib/theme.ts`), and only that button does.

## Typography

**Display Font:** the platform system face (SF Pro on iOS, Roboto on Android, system-ui on web)
**Body Font:** the same system face
**Label/Mono Font:** none separate; figures use tabular numerals of the system face

**Character:** one native face, so the app feels at home on every OS. Hierarchy comes from size and weight steps, never from a second family.

### Hierarchy
- **Display** (700, 32/38): the bill total and other single hero figures.
- **Title** (700, 22/28): screen titles.
- **Headline** (600, 17/22): card and choice titles.
- **Body** (400, 16/22): row titles, paragraphs, input text.
- **Label** (600, 15/20): button labels, segment labels.
- **Section** (600, 13/18, in Muted Ink): the label above a group of rows ("Discounts", "Just now").
- **Caption** (400, 13/18): hints, secondary lines, field labels (field labels at 600).
- **Micro** (700, 11/13): avatar initials and "+N" counts only, inside small fixed shapes.

### Named Rules
**The Receipt Column Rule.** Money is always tabular (`tabularNums`), right-aligned in lists, with the `$` shown, and formatted only through `lib/money.ts`. The bill total is the largest number on the screen.

**The Scale-Stays-On Rule.** Font scaling (Dynamic Type) stays on; text containers never get fixed heights.

## Layout

A single phone-shaped column on every platform. Screens sit on Table Grey with a 16 px edge (`layout.screenPadding`). Reading screens are held to 560 px wide (`layout.content`), the bill form to 640 px (`layout.form`), and a lone sentence (empty states, sign-in) to 360 px (`layout.message`), centred on wide screens.

Spacing uses a 4-point scale (4, 8, 12, 16, 24, 32). Rhythm: items inside a row sit 4–12 apart, rows inside a group 12–16, groups 24, sections 32. Long forms keep the main action and the total in a sticky footer within thumb reach. Safe areas are always respected.

## Elevation & Depth

The system is flat. Depth comes from tone (Receipt Paper cards on Table Grey, Muted Paper for quieter groups) and from hairline edges. There is exactly one shadow, and it carries meaning.

### Shadow Vocabulary
- **Tappable card** (`box-shadow: 0 1px 3px rgba(17, 24, 39, 0.08)`): only on a card where the whole surface is one tap target (`ChoiceCard`). In dark mode it is barely visible, which is fine.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat. A shadow means "this whole card is tappable" and nothing else. Grouping is done with tone, space and hairlines.

## Shapes

Gently rounded, continuous corners (`borderCurve: 'continuous'`) everywhere: 8 px for inputs and segmented tracks, 12 px for buttons and banners, 16 px for cards and sheets, a full pill for icon buttons and avatars. A shape nested inside another sits 2 px in with a 6 px radius, so the curves stay parallel. Borders are hairlines on cards and 1 px Control Border on inputs (2 px while focused or in error). Icons are lucide line icons at one stroke (1.75) in three sizes (16, 20, 24).

## Components

### Buttons
Quiet and confident: one filled button per screen, everything else steps down.
- **Shape:** gently rounded (12 px), at least 44 px tall, 16 px side padding, label in Label type.
- **Primary:** Settle Teal fill with white (dark mode: deep teal) text. One per screen: the main next step.
- **Secondary:** Teal Wash fill, Settle Teal text, no border. The default variant.
- **Ghost:** no fill, Settle Teal text, for low-weight actions.
- **Danger:** Danger Wash fill with Danger text; never the default action.
- **Pressed / Disabled:** 70% opacity while pressed, 50% when disabled; a spinner replaces the label while loading.
- **Focus (web, keyboards):** a 2 px Settle Teal outline, 2 px off the edge.

### Cards / Containers
- **Corner Style:** 16 px, continuous.
- **Background:** Receipt Paper with a hairline edge; the muted variant is Muted Paper with no edge.
- **Shadow Strategy:** none (see Elevation), except a whole-card tap target.
- **Internal Padding:** 16 px, with 12 px between the header and the content. Optional title in Headline with a caption aside on the right.

### Inputs / Fields
- **Style:** Receipt Paper fill (Muted Paper for subtle ones), 1 px Control Border, 8 px radius, 44 px tall (36 px subtle). Label above in Caption 600 Muted Ink; hint below in Caption.
- **Focus:** the border thickens to 2 px and turns to the focus teal.
- **Error:** a 2 px Danger border plus a Danger caption under the field, announced as an alert. Never colour alone.
- **Money fields:** a `$` prefix in Muted Ink, tabular numerals, the decimal keypad.

### Segmented control
- A Muted Paper track (8 px radius); the selected segment is filled Settle Teal with white text at weight 700, inset 2 px with a 6 px radius. Used for small exclusive choices (proportional vs even split, % vs $).

### List rows
- At least 56 px tall, 16 px side padding, a 12 px gap between avatar, text and trailing figure. Title in Body, caption in Muted Ink. Pressed rows tint to Muted Paper. A row's accessibility label says everything the row shows, in reading order.

### Banners
- 12 px radius, 12 px padding, no border: an icon plus a title and text on the matching wash (info uses Muted Paper and Muted Ink).

### Navigation
- A stack with a simple back header (`BackHeader`), screen titles in Title type. No tab bar; Home is the hub. Native back gestures and the Android Back button always work.

## Do's and Don'ts

### Do:
- **Do** take every colour, space, radius and type size from `lib/theme.ts`; no raw hex in screens.
- **Do** keep one filled Settle Teal button per screen and fold rare options behind a quiet control ("+ Add note").
- **Do** set money in tabular numerals, right-aligned, with the total the largest figure.
- **Do** design every state: empty (a friendly hint plus the action), loading, error, disabled.
- **Do** keep touch targets at 44×44 or larger (use `hitSlop` on small icons), and check both light and dark mode.
- **Do** use continuous corners and the single icon stroke (1.75) everywhere.

### Don't:
- **Don't** add shadows for depth; a shadow only means "the whole card is tappable".
- **Don't** introduce a second accent colour, gradients, glassmorphism, decorative illustrations, confetti or bouncy entrance animations.
- **Don't** show status by colour alone; always pair it with an icon or words.
- **Don't** use emoji as icons, or mix in a second icon set.
- **Don't** fix the height of a text container or turn off font scaling.
- **Don't** use Google's button colours anywhere except the Google sign-in button.
