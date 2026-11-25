# Scan screen redesign (visual only)

Date: 2026-11-25. Requested by the user: "make the scan receipt page look more aesthetic… clean and pretty… I would like the options to enter manually or scan to be in the center."
Screen: `app/(app)/scan.tsx`. Behavior specs it must keep: `docs/specs/2026-11-20-m1a-scan-receipt.md` (Tasks 7, 9) and `docs/specs/2026-11-22-web-opencv-preprocessing.md` (Task 10).

## Who and why
The host, at the table with the receipt in hand, wants to get the items into SplitIt the fastest way: by photo, or by typing them.

## Primary action
Two equal choices, centered: **scan** (capture label) and **enter items** (manual). Neither is hidden or demoted; scanning is listed first. Every other control (Cancel, Open Settings, Retake photo / Type it in) appears only in the state that needs it.

## Layout
```
            Scan receipt                 <- title, header role
     Start a bill from your receipt.     <- one quiet line (textMuted)

   [ banner, only in an error/permission state ]

  +-------------------------------+
  |           ( camera )          |      <- icon in a soft tinted circle
  |          Take photo           |      <- label (title of the choice)
  |  Point the camera at the ...  |      <- one-line hint (textMuted)
  +-------------------------------+
  +-------------------------------+
  |           ( pencil )          |
  |          Enter items          |
  |  Type each item and its price |
  +-------------------------------+
```
- The whole group is centered vertically and horizontally, max width 560.
- The two choices are equal cards: surface color, hairline border, `radius.lg` with `borderCurve: 'continuous'`, one subtle `shadow.card`. They stack on phones and sit side by side when there's room (flex-wrap with a minimum width, no JS measuring).
- Press feedback: the card's background turns `surfaceMuted`. On web, a keyboard focus ring in `colors.focus`. No entrance animations.
- Icons: `lucide-react-native` (Camera, PencilLine), drawn in `colors.primary` on `colors.primarySurface`; hidden from screen readers.

## States
| State | What shows |
|---|---|
| Idle | Title, intro line, the two choices |
| Camera permission asked / declined (`ask`) | Warning banner "SplitIt needs the camera to read your receipt." above the choices; scan choice reads "Try again" |
| Camera blocked | Warning banner "Camera access is off for SplitIt. Turn it on in Settings." + "Open Settings" button under it; choices below |
| Camera failed / read failed / reader failed to load | Error banner with the existing fixed copy; scan choice reads "Try again"; "Enter items" still there |
| Reading | Title, spinner (or progress bar once a percentage is known), the stage line (`progressCopy`), Cancel. Unchanged apart from spacing |
| Unclear read / timed out (failure screen) | Unchanged content and buttons ("Retake photo" primary, "Type it in"); same centered column as idle |
| OCR unavailable (Expo Go, browser without WebAssembly) | Title, info line "Scanning works in the iPhone app. You can enter the items yourself.", and only the "Enter items" choice card |
| Web vs native | Only the labels and hints differ (below). Nothing branches on `Platform.OS` in the layout |

Deep links and sign-in: `/scan` is inside the protected group; nothing here navigates on its own, as today.

## Copy
Kept: the title "Scan receipt", every banner/progress/failure string, "Try again", "Open Settings", "Cancel".
- Capture label (`CAPTURE_LABEL`, unchanged): native "Take photo", web "Take or upload photo".
- Manual label (`MANUAL_ENTRY_LABEL`): web "Enter items" (unchanged); native **changes from "Type it instead" to "Enter items"**. Two equal choices shouldn't frame one as the fallback, and this matches web and the unavailable state. (Logged as SR-2 in `docs/decisions-to-review.md`.)
- New, in `lib/scanScreen.ts` (`CHOICE_COPY`):
  - Intro: "Start a bill from your receipt."
  - Scan hint, native: "Point the camera at the receipt and we'll fill in the items."
  - Scan hint, web: "Use a photo of the receipt and we'll fill in the items."
  - Manual hint: "Type each item and its price yourself."
  The hint is both the visible line and the card's `accessibilityHint`; the card's `accessibilityLabel` is its title.

## Acceptance criteria
1. Idle shows the title, the intro line, and exactly two choice buttons (capture label, manual label), each with its hint as visible text and as `accessibilityHint`. Native and web (`Platform.OS = 'web'`) both tested.
2. Pressing the scan choice runs the same scan as before; pressing "Enter items" clears any scan result and opens the empty bill form (existing tests 40a, 43 and the web-label test, updated for the native label).
3. Permission, error and timeout states show the same banners and copy as before, above the choices; the scan choice reads "Try again" in those states.
4. Unavailable shows the info line and only the "Enter items" choice; no capture choice.
5. Reading, progress, Cancel and the failure screen behave and read exactly as before (existing tests pass unchanged).
6. Tokens only: no hex colors, font sizes or spacing literals in `app/(app)/scan.tsx` or the new component (the progress bar's height already uses tokens). `borderCurve: 'continuous'` on the cards; one shadow token.
7. Each choice is a `Pressable` with `accessibilityRole="button"`, a label, a hint, `minHeight` >= 44 and no fixed text heights (Dynamic Type grows the card).
8. `npm test -- --maxWorkers=4` and `npm run typecheck` pass; the web bundle for `/scan` compiles.
