# Backlog: queued work

Work the user has asked for, waiting for its turn. Each item has the user's decisions so far. The main session picks these up in order once the current milestone (M1b+M2 share-and-claim) has finished review, QA and retro. Each runs as its own small build-task (spec → implementer → review → QA).

## 1. Custom tip when the receipt has none (queued 2026-11-22) — DONE 2026-11-22
**Done 2026-11-22:** the Tip row in the bill form (manual entry, post-scan review and host edit) has 15% / 18% / 20% / 25% chips, each showing its dollar amount, plus Custom with a % | $ switch. The % is taken on the subtotal before tax (or items less before-subtotal discounts if the subtotal is blank), rounded half up to the cent with integer math (`percentOfCents` in `lib/money.ts`, `tipPresets`/`setTip` in `lib/billDraft.ts`). Only `tip_cents` is saved (no % column), so editing later shows the dollar amount. The total follows the tip when it is blank or matches the pre-tip sum (within 1 cent); a different typed total is left for the totals check to flag. Chips show when there's no tip, and behind "Tip options" (or focusing the Tip field) when there is one.

**User's request:** "if receipt was before tip - add an option to add custom tip amount (percentage/raw value)".

**User decisions:**
- A tip percentage is calculated on the **subtotal, before tax** (after any before-subtotal discounts). Example: 20% of a $40.00 subtotal is $8.00.
- Control: **quick % chips (15% / 18% / 20% / 25%) plus "Custom"**, which takes either a % or a $ amount (a small % | $ switch). It always shows the dollar amount it works out to.

**Notes for the spec:**
- Lives in the bill form (`components/BillForm.tsx`, logic in `lib/billDraft.ts`), so it works for manual entry, after a scan, and in the host edit screen.
- Percent → cents must be integer math with a stated rounding rule (e.g. round half up to the cent), never floats (`lib/money.ts` conventions).
- What's saved is the tip in cents (the DB stores `tip_cents`). Open question for the PM: also remember the chosen % so editing later shows "20%" rather than "$8.00"? That would need a column.
- The total updates automatically when a tip is added to a receipt that had none. Decide whether the printed total stays as typed or is recomputed.
- Use the `ui-ux-designer` skill; keep it uncluttered (e.g. chips only appear in the Tip row).

## 2. Parser: quantity next to the item, and tax, on the "Miami" receipt (queued 2026-11-22)
**User's report:** "quantity is usually the number left or right of the item. The Miami receipt is not correctly getting quantity and the tax."

**What's needed first:** the actual receipt.
- Save the photo as `eval/receipts/miami.jpg`. The folder exists and is gitignored, so the photo stays on this Mac and is never committed.
- The engineer then runs the same Tesseract pipeline in Node on it (as done for Task 9) to get the exact recognized lines, writes them as a test fixture, and fixes `lib/receiptText.ts` test-first.

**Notes for the engineer:**
- Quantity can appear **before** the name (`2 Mojito 24.00`) or **after** it (`Mojito 2 24.00`, `Mojito x2 24.00`). Today the parser handles a leading quantity, `2 x` and `@` forms, and qty/unit/total columns (review R4). A bare integer *between* the name and a single line price may not be read as a quantity. Check the R6 unit stop-list (`12 oz`) still holds.
- Tax: find out why it's missed. Likely an unrecognized label (e.g. "Sales Tax 7%", "FL Tax", "Tax 1"), a percent figure read as the amount, or several tax lines that should add up.
- Add each case as a fixture, and re-check all existing fixtures still pass.
- While there, consider the deferred dev-only **"Copy recognized text"** button (M1a out-of-scope list). It would let the user send recognized text from any future problem receipt without sharing the photo.

## 3. Scan pipeline: phone scanner → retry → retake/manual (queued 2026-11-22)
**Status (2026-11-25):** web part built (spec `docs/specs/2026-11-22-web-opencv-preprocessing.md`, Tasks 1–14; [ADR 0018](learning/decisions/0018-staged-scan-pipeline.md), [ADR 0019](learning/decisions/0019-opencv-on-web.md)). Every scan now runs the staged pipeline, and the quality check plus the "Retake photo / Type it in" screen are live on web and native. Every new step is switched off (`PIPELINE.web` = today's read, `WEB_CV_PREPROCESS = false`, checked in `lib/scanPipeline/config.ts`). **Waiting on the user:** check more answer files, then re-run Task 14 to decide whether the crop (and maybe the 40 px text-height pass) ships (decision S-1). **Not started:** the native part (the phones' document scanners, a native retry); it needs a development build and its own spec. The flow below is the original proposal; see the spec for what was built.

**User's request:** use the phone's built-in document scanner; if reading doesn't work, try again with grayscale; if nothing works, ask the user to retake the photo or type the items in. The user is open to adding OpenCV.

**Proposed flow (to be specced once the research report `reports/Receipt OCR preprocessing pipeline.md` lands):**
1. **Capture:**
   - **iPhone/Android:** open the OS document scanner (VisionKit document camera / ML Kit Document Scanner, e.g. via `react-native-document-scanner-plugin`; needs a dev build). It auto-crops, flattens and cleans the photo.
   - **Fallback:** the current camera/photo picker when the scanner isn't available (no Play services, low RAM, user cancels) and on web.
2. **First read** on the scanner's (or picker's) image, with the current prep (size normalisation).
3. **Decide whether it "worked"** using a pure, tested rule. Possible signals: no items found; totals don't reconcile; very few recognised lines; low average word confidence (web).
4. **Retry once** with a grayscale + gentle contrast / even-lighting version. No black-and-white conversion: the research says it hurts modern engines. Keep whichever result reconciles better.
5. **Still failing:** a friendly screen with "Retake photo" or "Type it in", plus what we did read pre-filled so nothing is lost.

**OpenCV on web (open question):** opencv.js is ~10–13 MB. If added, it must be lazy-loaded only when someone scans on web, used for receipt edge detection + perspective correction (what the phone scanners already do natively), and kept only if it measurably improves the receipt eval.
