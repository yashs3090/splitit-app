# On-device text recognition (OCR)

## The idea
**OCR** (optical character recognition) turns a picture of text into actual text. Modern phones ship an OCR model inside the operating system, so an app can read text **on the device**, with no server and no network call:

- **iOS: Apple Vision.** You create a `VNRecognizeTextRequest` and run it on an image. It returns a list of `VNRecognizedTextObservation`s, one per region of text it found. Each observation gives ranked guesses (`topCandidates(_:)`), and each guess has a `string` and a `confidence` from 0 to 1. Each observation also has a `boundingBox`: where on the image the text is, in **normalized** coordinates (0 to 1, as a fraction of the image width and height) with the origin at the **bottom-left**. You can choose a `.fast` or `.accurate` recognition level. Vision also needs to be told the photo's **orientation** (an iPhone portrait photo is stored sideways with a "rotate me" flag); if you don't pass it, Vision reads the text sideways.
- **Android: Google ML Kit Text Recognition v2.** Google's docs say "ML Kit's processing happens on-device." It returns a tree: **blocks** (a paragraph or column) contain **lines**, lines contain **elements** (words), and elements contain **symbols** (characters). Every level has its text, a bounding box, a rotation angle, a confidence score and a detected language.
- **Web: Tesseract.js.** Browsers have no built-in recognizer, so we ship one. Tesseract is an open-source OCR engine; Tesseract.js runs it in the browser as WebAssembly inside a Web Worker (a background thread). It's still "on device": the photo never leaves the browser. It returns `blocks → paragraphs → lines`, each line with `text` and a `bbox {x0, y0, x1, y1}` in pixels.

What you get back is something like this (simplified, after our code converts it to pixels with a top-left origin):

```
"CHKN SNDWCH"   box x=80  y=1420 w=400 h=30
"TAX"           box x=80  y=1560 w=80  h=30
"12.50"         box x=780 y=1421 w=120 h=30
"1.09"          box x=800 y=1561 w=100 h=30
```

That's **text plus positions**, not meaning. Nothing in it says "this is an item that costs 1250¢" or "this is the tax." And notice the order: both names first, then both prices. Vision often does this.

### Apple Vision vs. Tesseract in a browser
| | Apple Vision (iPhone app) | Tesseract.js (web) |
|---|---|---|
| **Where it runs** | Inside iOS, on the phone's neural hardware. Part of the OS, nothing to download. | In the browser tab: WebAssembly in a Web Worker. Works on desktop and phone browsers. |
| **How we reach it** | `expo-mlkit-ocr` with `iosEngine: "vision"` ([ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md)) | `tesseract.js` 7.0.0, loaded lazily, assets self-hosted under `/tesseract/` |
| **Download size** | 0 extra (the model is in iOS) | About **7 MB on the first scan** (one WebAssembly core of ~3.9 MB plus the ~2.95 MB English model), then cached. Our web build carries ~15 MB because it ships all three core variants and the browser picks one. |
| **Accuracy (expected)** | Good on phone photos of receipts: built for camera images, handles some curve and blur. | Generally weaker on phone photos (curved paper, low contrast, faded thermal print). Tesseract was designed for scanned documents; its docs say it works best at about 300 DPI with level, horizontal lines. |
| **Speed (expected)** | Spec target: items on screen within about 5 seconds. | Several seconds per receipt on a mid-range phone, plus worker start-up. That's why web shows a progress bar and a Cancel button. |
| **Tuning knobs** | Recognition level, language correction (on in the library; Task F would turn it off) | Engine mode (OEM 1 = LSTM only), page segmentation mode (we use 6), `preserve_interword_spaces`. Thresholding method, DPI hint, auto-rotate and dictionaries were measured on 2026-11-23 and none helped ([the scan pipeline](scan-pipeline.md#how-the-decisions-were-made)) |

The accuracy and speed rows are **expectations, not measurements** for Vision: nobody has run it on SplitIt receipts yet (device check D3). Tesseract on web now has first numbers from the desktop harness (Chromium on a Mac, a handful of checked receipts; see "Accuracy" below), but not from a phone browser (criterion 61). The receipt eval decides whether Tesseract stays.

### How bounding boxes pair names with prices
A receipt row is "name on the left, price on the right, same height". The recognizer doesn't know that, so we rebuild rows from the boxes (`lib/receiptRows.ts`):

1. **Find the typical line height:** the median box height. Using the median means one huge logo doesn't throw it off.
2. **Group by height:** sort lines by the vertical centre of their box. Walk down the list; a line joins the current row if its centre is within **half a line height** of the row's average centre. Otherwise it starts a new row.
3. **Order within a row:** sort the row's pieces left to right, then join them with spaces. "CHKN SNDWCH" + "12.50" becomes the row `CHKN SNDWCH 12.50`.

In the example above: line height 30, so the tolerance is 15. "CHKN SNDWCH" has centre y = 1435 and "12.50" has 1436, which is within 15, so they form one row. "TAX" (1575) is 140 lower, so it starts a new row and pairs with "1.09".

**Tilt correction (de-skew).** If the photo is a little rotated, a row slopes: the price on the right sits lower than its name on the left. Say the line height is 30 (so the tolerance is 15), "Burger" has centre (100, 100) and its price "12.99" has centre (500, 124). They're 24 apart, more than 15, so plain grouping would split them into two rows. The fix:
- **Estimate the slope.** For each line, find the nearest line to its right whose centre is within one line height (30) up or down. That's usually its price. Each pair gives a slope `dy / dx`. Take the **median** of all the slopes, so one wrong pairing doesn't matter. Here: 24 / 400 = 0.06.
- **Level the centres.** Before grouping, compute each line's "level" centre: `centreY − slope × centreX`. Burger: 100 − 0.06 × 100 = 94. Price: 124 − 0.06 × 500 = 94. Now they match, and they group into one row.
- **Safety limits.** With fewer than 3 pairs, there isn't enough evidence to tell tilt from a messy layout, so we don't correct. Slopes steeper than 0.2 (about 11°) are capped, because that's more likely noise than tilt. And because the pair search only looks one line height up or down, a tilt so steep that the price drops more than a full line isn't detected at all.

If grouping still splits a name from its price, the parser has one more fallback: a row with text but no price, directly followed by a row that is only a price, gets joined (`mergeSplitRows` in `lib/receiptText.ts:153`).

## Why it matters here
[ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md) chose on-device recognition so SplitIt needs no custom backend:
- **No key to protect and no per-scan cost.** The model is part of the OS (or, on web, files we serve), so there is no API key to leak and no bill per receipt.
- **Privacy.** The receipt photo never leaves the phone or browser to be read. Nothing is uploaded in M1a.
- **Works offline** on the phone (device check D8).

The price is that **turning text into meaning is our job.** That's the parser, `lib/receiptText.ts`. It:
1. Rebuilds receipt rows from boxes (above).
2. Finds **items** with their **quantity** ("2 x TACO"), **modifiers** ("+ avocado 2.00", folded into the item above), and **discounts**.
3. Finds the **subtotal, tax, fees, tip and total** lines, and ignores card-slip noise and suggested-tip tables.
4. Converts every amount to **integer cents** ([money and rounding](money-and-rounding.md)).
5. Runs the **totals check** (below). If it fails, the form shows a red banner and the host fixes the numbers.

### How the totals check catches misreads
OCR mistakes are usually small: a "3" read as an "8", a dropped digit, a price stuck to the wrong row. We can't detect those by looking at one number. But a receipt has **built-in redundancy**: the items must add up to the subtotal, and subtotal + tax + fees + tip − discounts must equal the total. `checkTotals` (`lib/receiptText.ts:296`) checks both sums, allowing ±1¢. If Vision reads "Fries 3.99" as "8.99", the items now sum 5.00 more than the printed subtotal, so the check reports `items_vs_subtotal` and the host sees "The items don't add up to the subtotal." The check can't say *which* line is wrong, only that something is. So the host always gets an editable form, and the same check re-runs live as they type (`evaluateDraft` in `lib/billDraft.ts:167`).

## How we use it
The scan flow, in order: capture the photo, run it through the **scan pipeline** (find and crop the receipt, size the text, read, parse, check the result), put the result in memory, open the form, then delete the temp images. The screen calls one function, `scanReceipt` (`app/(app)/scan.tsx:189`), and either opens the form (`:217-219`) or shows "Retake photo / Type it in". The pipeline has its own note: [the scan pipeline](scan-pipeline.md). *(Updated 2026-11-25: before the pipeline, the screen called the recognizer directly.)*

- **The contract:** `lib/textRecognition.ts:24` defines `TextRecognizer` (`isAvailable()`, `recognize(uri, { onProgress, onStage, signal })`). Every platform file returns `{ lines: [{ text, box }] }` and fails only with a `RecognitionError` code. Metro picks the `.native.ts` or `.web.ts` file at build time; see the concept section of [ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md).
- **iOS/Android:** `lib/textRecognition.native.ts`.
  - The library is loaded lazily on first use (`:22`), so a build without the native code (Expo Go) reports "not available" instead of crashing.
  - `mapOcrResult` (`:53`) flattens `blocks[].lines[]` into our lines and keeps boxes. Android sometimes returns `{}` for a box; that's treated as "no box".
  - `mapOcrError` (`:71`) turns library error codes into ours (`image_load_failed` or `failed`).
- **Before recognition:** `prepareForRecognition` (`lib/prepareImage.native.ts:40`) always re-renders the photo and caps the long edge at 2048 px (`RECOGNITION_MAX_EDGE`, `lib/imageSize.ts:4`). Photos whose long edge is under 1000 px are enlarged to 1600 px first (`RECOGNITION_UPSCALE`, `lib/imageSize.ts:21`), because their letters are too few pixels tall to read. The re-rendered image should be upright, which sidesteps the library's box bug on rotated photos. Device check D4 confirms it. In the pipeline this is the "size" stage; on web it is applied to the **cropped receipt** when the crop is on ([the scan pipeline](scan-pipeline.md)).
- **Web:** the big library stays out of the main bundle.
  - `lib/scanReceipt.web.ts` loads the web stages with `import()` only when you scan (`webStagesLoader`, `:25`).
  - The stages (`lib/scanPipeline/web/stages.ts`) read through one Tesseract session per scan (`createOcrSession`, `lib/webOcrSession.ts:133`). The session reports progress, handles Cancel, gives each read a 30 s limit (`RECOGNIZE_TIMEOUT_MS`, `:59`) and always terminates the worker.
  - `lib/webOcrEngine.ts` is the only file that imports `tesseract.js`. It holds the self-hosted asset paths (`tesseractPaths`, `:63`), the engine settings (`TESSERACT_PARAMS`, `:50`: page segmentation mode 6, `preserve_interword_spaces`), worker start-up (`startWorker`, `:171`) and the mapping from Tesseract's `bbox {x0,y0,x1,y1}` to our `{x, y, width, height}` (`mapTesseractResult`, `:145`). Since Task 5 it also keeps each line's confidence (0–100) when Tesseract gives one; the parser ignores it.
  - `lib/textRecognition.web.ts` (the older single-call recognizer) still exists and is tested, but the scan screen no longer calls it.
- **Rows:** `toRows` (`lib/receiptRows.ts:90`). Grouping is in `groupByBoxes` (`:58`) and the tilt estimate in `estimateSlope` (`:40`). If any line has no box, it falls back to the recognizer's order.
- **Parser:** `parseReceipt` (`lib/receiptText.ts:587`). The price on a row is its last money token (`splitPrice`, `:50`). The totals check is `checkTotals` (`:525`). The rules for quantities, prices and totals are in the next section. *(Line numbers checked 2026-11-25; this file is edited often, so search for the function name if a line has moved. Line numbers in the parser-rules section below date from when each rule was added.)*
- **Form:** `fromParsed` (`lib/billDraft.ts:138`) turns the parsed receipt into editable strings, and `evaluateDraft` (`:224`) re-validates and re-checks totals on every keystroke. Why the form holds strings, not numbers: see [money and rounding](money-and-rounding.md#form-input-strings-in-cents-out).
- **Accuracy:** measured by the receipt eval, which runs the parser over saved recognition output (free; no model is called). The web reads come from a headless-browser harness running the app's own pipeline, and the right answers come from answer files you check by hand: `npm run ocr:harness`, `npm run answers:draft` / `answers:check`, `npm run eval` ([receipt answers](../../setup/receipt-answers.md); [the scan pipeline](scan-pipeline.md#measuring-harness-answer-files-eval)). On 2026-11-24, web line-item accuracy on the 3 checked tuning receipts was 36.4% with today's settings (72.7% with the proposed crop), and 8.3% on the 2 checked held-out receipts. That's far too few receipts to trust; the target is at least 12 + 8. If accuracy stays under 85%, the shelved fallback is Claude in an Edge Function ([LLM structured extraction](llm-structured-extraction.md)). That's the user's decision.

### Preparing the photo before reading (2026-11-25)
The research report `reports/Receipt OCR preprocessing pipeline.md` ("Fix geometry and scale, never binarize") looked at what each engine wants before it reads:
- **Geometry first, for every engine.** Crop to the receipt and straighten it. Every vendor recommends it, and cropping before the 2048 px cap puts more pixels into each letter.
- **Then letter size.** Tesseract reads best with capitals roughly 20–35 px tall; ML Kit wants characters at least 16 px and gains nothing above 24 px; Apple Vision ignores text smaller than 1/32 of the image height by default.
- **Filters only for Tesseract, and only if measured.** Grey and even lighting may help Tesseract; Vision and ML Kit are best left alone.
- **Never black-and-white.** Tesseract's reader uses the grey pixels; a binarized image throws them away.

SplitIt built this as a staged pipeline ([ADR 0018](../decisions/0018-staged-scan-pipeline.md)), with OpenCV doing the cropping on web ([ADR 0019](../decisions/0019-opencv-on-web.md)), and measured each step. So far only the crop has helped, and none of the new steps is switched on yet. The full story, with the results table, is in [the scan pipeline](scan-pipeline.md).
- **Dev builds, not Expo Go.** The iOS/Android library contains native code. Expo Go is a prebuilt app with a fixed set of native code, so it can't load it. You need a **development build**: `npx expo run:ios --device` (needs Xcode 26.4+). As of 2026-11-21 this first device build (D1) **hasn't run yet**.

### Parser rules: quantities, prices and totals (2026-11-22)
These rules came from running the parser on real Tesseract output of two photographed receipts (El Chalan and La Cabaña). Each rule below is in `lib/receiptText.ts` and has tests in `lib/receiptText.test.ts:541-713`.

**1. A price always has exactly two decimals** (`NUM`, `lib/receiptText.ts:10`). `12.99`, `$12.99` and `1,234.50` are prices. `12`, `12.5` and `1299` never are. Integers are left for quantities, so a row like `Mojito 2 24.00` has exactly one price.

**2. The quantity is a whole number right before or right after the name.**
- Before: `2 Burger 25.98` or `2 x Burger` / `2x Burger` (`QTY_X_RE` and `QTY_LEAD_RE`, `:173-177`; `leadingQty`, `:202`).
- After: `Mojito x2 24.00`, `Mojito x 2 24.00`, `Mojito 2x 24.00` or `Mojito 2 24.00` (`QTY_TAIL_RE`, `:181`; `trailingQty`, `:194`).
- A size isn't a quantity: `12 oz Steak` stays one steak (`SIZE_UNIT_RE`, `:179`).

**3. A bare number *after* the name only counts in three cases** (`toItem`, `:235-243`). Otherwise it's part of the name:
- it's written with an x (`x2`, `2x`), or
- the receipt has a column header with QTY in it, or
- the price divides by it exactly.

So `Mojito 2 24.00` is 2 × $12.00, but `Wings 10 12.99` stays one item called "Wings 10", because 1299¢ doesn't split into 10 equal whole cents.

**4. A QTY column header decides which side wins** (`QTY_HEADER_RE` and `ITEM_HEADER_RE`, `:72-73`; detected at `:320-326`). If a header like `ITEM QTY PRICE` puts QTY after the name, the number after the name is the quantity, even when a stray number appears before it. If it's `QTY ITEM PRICE`, the number before the name wins. Example: on El Chalan, Tesseract picked up a stray "4" at the left edge of the Causa row. If that row had read `4 CAUSA DE POLLO 1 $8.95`, the `ITEM QTY PRICE` header means the "1" after the name is the quantity, not the "4" (test at `lib/receiptText.test.ts:571-574`).

**5. A number followed by `.` or `)` stays in the name** (`QTY_LEAD_RE`, `:174-177`; the user's rule, 2026-11-22). Those are menu numbers. `1 6. Taco y Enchilada` is qty 1 of "6. Taco y Enchilada", and `6. Taco y Enchilada` alone is qty 1 too. `2 2) Combo 24.00` is qty 2 of "2) Combo".

**6. Tax lines** (`TAX_RE` and `TAX_SUM_RE`, `:60-62`; `totalKind`, `:99-110`; adding them up, `:388-395`).
- "Tax", "Taxes", "Sales Tax", "HST", "GST", "VAT" are tax, not the total.
- Several tax lines are **added up**: "FL Tax 0.60" + "County Tax 0.20" = 80¢.
- A "Total Tax(es)" or "Tax Total" line is the sum of the lines above it, so it **replaces** them instead of being added on top. Without this, the tax would be counted twice (160¢ instead of 80¢). It's checked before "total", so "Total Taxes $3.67" is tax and never the bill total.

**7. Suggested-tip rows are skipped** (`:66-69`, `:127`, `:145`). A row with two or more percentages (`15% 20% 25%`), percentage rows directly under a "Suggested", "Tip guide" or "Gratuity guide" header, and a row that is only amounts (`$7.43 $9.90 $12.38`) are never a tip or an item. "TIP IS NOT INCLUDED" isn't a tip either: it has no price.

**8. Cash and card price lines are ignored** (`PAYMENT_RE`, `:75`, used at `:135`). Some restaurants print a cash-discount price, like "Pay With Cash: 55.49", "Cash Price 55.49" or "Card Price 57.71". These are never the total, an item or a tip, whether they come before or after the real total.

**9. "Optional service" is the tip, not a fee** (the user's rule, 2026-11-23; `OPTIONAL_SERVICE_RE`, `lib/receiptText.ts:76`, checked in `totalKind` before the fee rule; tests at `lib/receiptText.test.ts:981-1061`). A service line the guest may decline is a tip: `Optional Service 15.00`, `Optional Service (18%) 15.00`, `Optional Service Charge 12.40`, `OPT SERVICE 9.00`, `Optional Svc 9.00`, and the same convention worded "Discretionary" or "Voluntary" service charge. A plain `Service Charge` / `Service Fee`, or a "Mandatory Service Charge", is still a fee.
- **No double counting** (`chooseTip`, `lib/receiptText.ts:529`). A receipt can print the optional service on the bill and a tip again on the card slip. That could be the same tip twice, or two tips. The last tip line is the tip (as before). The tip lines are added up only when their sum is what makes subtotal + tax + fees + tip match the printed total and the last line alone does not. So `Optional Service 15.00` … `Tip 15.00` is one $15 tip, while `Optional Service 12.00` … `Additional Tip 5.00` with a total that includes both is $17. With no total to check, the last line is kept, and if nothing reconciles the totals banner flags it.
- **Left out on purpose:** "Suggested Gratuity (18%) 14.40" stays skipped as a tip-guide row (rule 7): a suggestion isn't charged, so it is usually not in the total. "Svc Charge" without "optional" isn't recognised as a fee or tip (it reads as an item; the host fixes it). Words like "Service" in an item name ("Room Service Burger") are untouched.

**10. Unit-price notation `(2@3.50)` is qty 2 × unit $3.50** (the user's rule, 2026-11-23; `UNIT_NOTE_RE` and `findUnitNote`, `lib/receiptText.ts:158-179`; tests in the two `unit-price notation` describe blocks and the `1-decimal unit inside the note` block in `lib/receiptText.test.ts`). The forms are `(2@3.50)`, `(2 @ 3.50)`, `(2@$3.50)`, `(2@3.50 ea)`, and bare `2@3.50` / `2 @ $ 3.50 each` between spaces. The qty is an integer (1–99, like every other qty rule). The unit price has one or two decimals (the user's rule, 2026-11-24): `(2@3.5)`, `(10 @ $1.5)` and `Pie (2@3.5) 7.00` are notes (2 × 350¢, 10 × 150¢). The 1-decimal exception holds **only inside the note**; everywhere else rule 1 stands, so `Tea 3.5` has no price. In code, `noteUnitCents` pads `3.5` to `3.50` and hands it to the same `parseMoneyToken` digit parser, so it stays integer math. A whole-number unit is still not a note (`(2@3)` stays in the name): without a decimal point, `2@3` could just as well be a count, a table or a size, and nothing on the row marks it as money. Three decimals (`(2@3.555)`), `(2 pcs)` and `Email @ checkout` are not notes either.
- The note is taken off the row **before** anything else reads it (`classify`, `:212`), so it is never a menu number (rule 5), never the price, and never a leading or trailing qty. The same qty also printed next to the name is dropped (`2 Margarita (2@3.50)` is "Margarita"); a different number stays in the name (`Combo 3 (2@3.50)`) (`toItem`, `:430`).
- The printed line total is kept. If qty × unit is more than 1¢ away from it, the item gets `qty_price_mismatch` (`noteFits`, `:472`), the same ±1¢ as the totals check, so a rounded unit like `Bagel (3@0.33) 1.00` is fine. With no line total, the price is qty × unit in integer cents.
- **Two-line form** (`unitNote` rows, `:597`): a line that is only `(2@3.50)` or `2 @ 3.50` goes to the item directly above, or else directly below. If both exist, the one whose price is qty × unit wins (the item above on a tie). A name line followed by `2 @ 3.50 7.00` is joined into one row (`mergeSplitRows`, `:263`). An item takes at most one note, and time, payment and header rows ("Party of 2 @ 7.00 PM") are skipped as before.
- The older `Soda 2 @ 2.50 5.00` column form (review R4) is now read by this rule and gives the same result.

**11. Two different "Total" lines and no Subtotal: the first is the subtotal** (the user's rule, 2026-11-24; spec `docs/specs/2026-11-24-first-total-as-subtotal.md`; `firstTotalSpan`, `lib/receiptText.ts:555`, and the fallback, `:756-779`; tests in the `first of two different totals is the subtotal` block). Some receipts print the food subtotal under the label "Total", then a service charge or tip, then a second "Total". The first Total becomes the subtotal and the last one the total, but only when all of these hold:
- exactly two different Total amounts, and no Subtotal line anywhere;
- no tax, tip or fee line before the first Total (on a card slip like `Tax / Total 50.00 / Tip 10.00 / Total 60.00`, the first Total already includes the tax);
- the first Total is below the last, or above it with a discount in between.
Tax, discounts and tips between the two Totals then count, except "VAT included" lines, which are already inside the first Total.
- **The safety net: try both readings.** The parser builds the receipt with the rule and without it. It keeps the old reading if the rule's reading adds a totals mismatch the old one didn't have, or if the rule added tax or a discount that doesn't make first Total + extras = last Total. The tip is always chosen as without the rule. So the rule can only ever add a subtotal; it can never make the total, tip or tax worse (the user's priority: total, tip and tax matter most, and a blank subtotal is fine).
- **The form** no longer asks for a missing subtotal: with none printed, the checks use the items' total, and a mismatch reads "The items, tax, fees and tip don't add up to the total." (`reasonCopy`, `lib/billDraft.ts`).

**Known limits** (the host fixes these in the form):
- `Combo 2 12.00` with no QTY header reads as **qty 2** of "Combo" at $6.00 each, because 1200¢ divides by 2 (rule 3). The parser can't tell "Combo number 2" from "two Combos" by the text alone. A test pins this behavior down (`lib/receiptText.test.ts:586-588`).
- `3 Cheese Pizza 30.00` reads as qty 3 of "Cheese Pizza", because a number before the name is always taken as the quantity (comment at `lib/receiptText.ts:176`).

### Real receipts: before and after
The two receipts are saved as fixtures twice: the raw Tesseract output (`tesseract-el-chalan`, `tesseract-la-cabana`, `lib/fixtures/receipts.ts:90-156`) and the text as printed (`el-chalan-as-printed`, `la-cabana-as-printed`, `:415-481`). The "as printed" ones show what a perfect read gives, so you can tell a parser bug from a recognition misread.

| Receipt | Before these rules | Now (Tesseract output) | Now (as printed) |
|---|---|---|---|
| El Chalan: 4 items, subtotal $45.85, "Total Taxes $3.67", total $49.52 | **Tax missing** | Tax **$3.67**, total $49.52, 3 of 4 items. Banner: items don't add up to the subtotal | All 4 items, tax $3.67, total $49.52. No banner |
| La Cabaña: 3 items (qty before the name, a "6." menu number, a price glued to ")"), subtotal $52.70, tax $5.01, total $57.71 | (not recorded) | 3 items with the right names and prices, tax $5.01, **total missing**. Banner: the total is missing | 3 items, tax $5.01, total $57.71. No banner |

The two remaining problems in the Tesseract column **are misreads, not parser bugs**, and the totals banner catches both:
- **El Chalan, Causa de Pollo.** Tesseract read its price as "AE da fe". With no price, the row isn't an item. The three items found add up to $36.90, which is $8.95 short of the $45.85 subtotal, exactly the Causa price. So `checkTotals` reports `items_vs_subtotal`, and the host adds the missing item.
- **La Cabaña, the total.** Tesseract read "57.71" as "57.1". That has one decimal, so by rule 1 it's not a price, and the parser reports `missing_total`. This is also where rule 8 matters: with the real total unreadable, a careless parser could have taken "Pay With Cash: 55.49" as the total, and the host would have seen a believable but wrong number. Instead the host is told the total is missing and types $57.71.

## Pitfalls
- **Skewed, crumpled or badly lit photos.** Rows tilt, so a name and its price end up at different heights. Our de-skew handles a gentle, even tilt. It can't fix crumpled paper, where different parts tilt different ways. The totals check is the safety net.
- **Item and price split apart.** Don't assume one recognized line is one receipt row. Vision often returns names and prices as separate pieces, sometimes all names first. Match by position.
- **Coordinate systems differ.** Vision's native boxes are normalized with a bottom-left origin; our `Box` is pixels with a top-left origin (`expo-mlkit-ocr` converts). Tesseract gives corners (`x0,y0,x1,y1`), not width and height. Mixing these up flips or squashes your rows.
- **Ignoring orientation.** A portrait iPhone photo is stored sideways plus an orientation flag. A recognizer that ignores the flag reads it sideways (one reason we rejected `expo-text-extractor`). A library that reads the flag but forgets to swap width and height for its boxes gives wrong boxes (`expo-mlkit-ocr`'s known bug; we avoid it by re-rendering).
- **Picking the wrong Tesseract page mode.** Mode 4 ("single column") sounds right for a receipt, but on our test receipt it dropped the whole price column. Always test layout settings on a real receipt.
- **Changing Tesseract's engine mode without the files.** We only self-host the LSTM-only core builds (OEM 1). Switching to another OEM also needs the other core files and the other language model, or the web scan fails to load.
- **Locale number formats.** `1.234,50` in Germany is `1,234.50` in the US. Never parse money with `parseFloat`; parse digits into cents yourself (`lib/money.ts`).
- **Look-alike characters.** OCR confuses `0`/`O`, `1`/`l`/`I` and `5`/`S`. "1O.5O" is probably 10.50. We don't fix these yet (out of scope for M1a). If we do, fix them only inside things that look like prices, never in item names.
- **Trusting one guess.** A high confidence score doesn't mean the number is right. The totals check is what catches a misread "8" for "3".
- **Testing native scanning in Expo Go** and wondering why it says scanning isn't available. Use a development build.
- **Testing the parser only on clean, typed receipts.** Real output has stray letters, glued prices ("Combo)21.95") and dropped digits. Keep a raw-OCR fixture next to an "as printed" one, so you can tell whether a wrong result is the parser's fault or the recognizer's.
- **Guessing a misread number.** When "57.71" comes back as "57.1", don't try to repair it or fall back to a nearby amount like the cash price. Leave it missing and let the host fill it in. A gap the banner shows is better than a believable wrong total.
- **Counting a "Total Tax" line on top of the tax lines it sums.** The tax doubles and the totals check fails for no visible reason.
- **Cleaning the photo up "to help OCR".** Black-and-white conversion, sharpening and heavy contrast often make reads worse: Tesseract's reader uses the grey pixels, and Vision / ML Kit do their own processing. Crop and size first; add a filter only if the eval shows it helps on held-out receipts ([the scan pipeline](scan-pipeline.md)).
- **Adding a "smart" rule without a fallback.** A rule that reinterprets lines (like "the first Total is the subtotal") will meet layouts nobody imagined. Compute the old reading too and keep it whenever the new one reconciles worse, so the rule can help but never hurt.

## Check yourself
1. Vision returns "Burger", "Fries", "12.99", "3.99" in that order, each with a box. What does `toRows` use to produce `Burger 12.99` and `Fries 3.99`, and why is the threshold half the *median* line height rather than a fixed number of pixels?
2. A photo is tilted so "Salad" has centre (100, 200) and its price has centre (600, 225). Line height is 30, and every row on the receipt is tilted the same way. Would plain grouping pair them? What slope would the tilt correction estimate, and what are the two levelled centres? What changes if the price's centre were at (600, 240) instead?
3. The tilt correction refuses to correct when it finds only two name/price pairs. Why is that safer?
4. Why does the web scan download about 7 MB the first time but almost nothing the second time? And why is our web build ~15 MB if a user only downloads ~7 MB?
5. Fries cost 3.99 but were read as 8.99. Which check fails, what does the host see, and why can't the app tell them which line is wrong?
6. Name two reasons we'd expect Apple Vision to beat Tesseract on a phone photo of a receipt, and say how we'll find out whether that's actually true for SplitIt.
7. With no column header, what do `Mojito 2 24.00`, `Wings 10 12.99`, `Wings x3 10.00` and `1 6. Taco 21.95` each parse to (name, qty)? Which rule decides each one?
8. A receipt has "FL Tax 0.60", "County Tax 0.20" and then "Total Taxes 0.80". What tax does the parser record, and what would go wrong if it added all three?
9. On La Cabaña, Tesseract read the total "57.71" as "57.1". Why is reporting "missing total" safer than using "Pay With Cash: 55.49"?
10. A receipt prints `Fish 54.00 / Total 54.00 / VAT 20% 9.00 / Gratuity 5.00 / Total 59.00`. Why must the parser not take 54.00 as the subtotal plus 9.00 tax, and which part of rule 11 stops it?
11. A 2000 × 3000 photo shows a receipt filling a third of the frame. Why does cropping to the receipt *before* the 2048 px cap give Tesseract larger letters than cropping after it?

## Learn more
- Apple, `VNRecognizeTextRequest`: https://developer.apple.com/documentation/vision/vnrecognizetextrequest
- Apple, Recognizing Text in Images: https://developer.apple.com/documentation/vision/recognizing-text-in-images
- Apple, `VNRecognizedTextObservation`: https://developer.apple.com/documentation/vision/vnrecognizedtextobservation
- Google ML Kit, Text Recognition v2: https://developers.google.com/ml-kit/vision/text-recognition/v2
- Tesseract.js (API, worker options, local installation): https://github.com/naptha/tesseract.js/tree/master/docs
- Tesseract, Improving the quality of the output (page segmentation modes, DPI, deskewing): https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html
- Expo, development builds: https://docs.expo.dev/develop/development-builds/introduction/
- Decision records: [ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md) (libraries), [ADR 0018](../decisions/0018-staged-scan-pipeline.md) (scan pipeline), [ADR 0019](../decisions/0019-opencv-on-web.md) (OpenCV on web)
- Research report: `reports/Receipt OCR preprocessing pipeline.md` (what each engine wants before it reads, with sources); notes in `research_notes/Receipt OCR preprocessing pipeline/`
- Next note: [the scan pipeline](scan-pipeline.md)
