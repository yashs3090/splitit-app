# M1a: Scan receipt → on-device text → parsed line items (local only)

Date: 2026-11-20. Milestone: first slice of M1 in `docs/plans/bill-splitting-app-2026-11-19.md`, as redefined by ADR 0010 (on-device recognition, our own parser, no custom backend).
Repo: `splitit-app` only (single repo; Supabase config lives in `supabase/`). This slice makes **no Supabase changes**.

> Amended 2026-11-25 (`docs/specs/2026-11-25-scan-screen-redesign.md`, SR-2): the native manual-entry label "Type it instead" is now "Enter items", as on web. Read "Type it instead" below as "Enter items"; the behavior is unchanged.

## Goal
A host taps "Scan receipt", takes a photo on their iPhone, and within a few seconds sees the receipt's line items, subtotal, tax, tip and total, read on the phone, in a form they can correct. If the numbers don't add up, the app says so, and the check updates as they edit. On web (or when a scan fails) the host fills the same form by hand. This tests the riskiest assumption behind ADR 0010: **that on-device text recognition plus our own parser can turn a real US restaurant receipt into correct line items.**

## Amendment A1 (2026-11-20): user decisions
The user answered the open questions. Tasks and criteria below are updated in place; this section is the record.
1. **Bundle identifier:** `com.yashs3090.splitit` for both iOS `bundleIdentifier` and Android `package` (Task 1 has set both in `app.json`).
2. **If `expo-mlkit-ocr` fails the D1 gate:** we write our own small Expo module calling Apple Vision, keeping line boxes. This is now the conditional **Task F**, pre-approved; it runs only if D1 fails.
3. **Manual entry is an item form, not a paste box.** One editable form component (`components/BillForm.tsx`) serves as (a) manual entry on web and behind "Type it instead", starting empty, and (b) the review/edit screen after a scan, prefilled by the parser. Fields: item name, qty, price, add/edit/delete rows, plus subtotal, tax, fees, tip, discounts and total, with a live totals check and the review banner. Money input goes through `lib/money.ts` as integer cents. **Still no DB writes**: saving stays in M1b. This replaces the read-only result screen and the paste box (old Tasks 5–7 become Tasks 5–8, and the old docs Task 7 is now Task 8).
4. **Priced modifiers fold into the parent item:** the price is added to the item, and the modifier text is kept as the item's note.
5. **The dev-only "Copy recognized text" button is deferred** to the next slice, alongside the eval script.

## Providers, accounts and costs (read first)
| Need | What | Cost | Status |
|---|---|---|---|
| Xcode | **26.4 or newer** (Expo SDK 57 minimum, per the SDK reference table) | Free | Installing. **Blocks all on-device checks.** An older Xcode will not build SDK 57. |
| Apple ID | Free "Personal Team" signing for `npx expo run:ios --device` | Free | Needed. Installs expire after 7 days; a free team can have at most 3 apps installed this way. |
| iPhone | **iOS 16.4 or newer** (SDK 57 minimum), with Developer Mode on (Settings → Privacy & Security → Developer Mode) | n/a | User to confirm the iOS version |
| iOS bundle identifier / Android package | `com.yashs3090.splitit`, set in `app.json` | Free | Decided (A1.1) |
| Apple Vision (iOS), Google ML Kit on-device model (Android) | Text recognition, runs on the phone | Free, no account, no key | n/a |
| Apple Developer Program, EAS, Expo account, Supabase hosted, any API | **Not needed for this slice** | $0 | n/a |

Nothing paid is needed. The only blocker is Xcode 26.4+ (for on-device checks).

## Library choices (verified 2026-11-20)
Lesson applied: "check against installed versions". No candidate declares SDK 57 support explicitly. All the Expo-module candidates use the Expo Modules API, which supports the New Architecture, and their peer deps are `expo: "*"`. So **Task 1 is a build gate**: install, run `expo-doctor`, and the user builds on the iPhone before anything depends on it.

### Camera: `expo-image-picker` (`launchCameraAsync`), recommended
- SDK 57 docs list `expo-image-picker ~57.0.21`. It uses the system camera UI, so we write no viewfinder, ref, `onCameraReady` or temp-URI handling. It returns `{ canceled, assets[{ uri, width, height }] }`. `requestCameraPermissionsAsync()` returns `granted` and `canAskAgain`, which is all the denied/blocked flow needs.
- Config plugin: `cameraPermission` sets `NSCameraUsageDescription`. Set `microphonePermission: false` (otherwise Android gets `RECORD_AUDIO`; we never record video). We set no `photosPermission` because we don't open the photo library in this slice.
- `expo-camera ~57.0.6` (`CameraView` + `takePictureAsync`) gives a custom viewfinder (e.g. a receipt-shaped guide), but it's more code and state for v1. Revisit if the system camera produces poor receipt photos.

### Resize: `expo-image-manipulator ~57.0.22`
Use the contextual API (`ImageManipulator.manipulate(uri).resize(...).renderAsync()` then `saveAsync({ format: JPEG, compress })`). `manipulateAsync` is deprecated. The docs don't say whether output normalizes orientation or strips EXIF. That's an on-device check (D4), not an assumption.

### Text recognition: `expo-mlkit-ocr ~0.2.7` with `iosEngine: "vision"`, recommended
| Candidate | iOS engine | Line bounding boxes | Maintenance | Notes |
|---|---|---|---|---|
| **`expo-mlkit-ocr` 0.2.7** (2026-05-06) | **Apple Vision** when `iosEngine` is `"vision"` or `"auto"` (the plugin sets `EXPO_MLKIT_OCR_DISABLE_MLKIT=1`, so no Google pods on iOS); ML Kit v2 on Android | **Yes:** `blocks[].lines[].{text, boundingBox{x,y,width,height}}` plus words, in image pixels, top-left origin | 1 maintainer, ~39 stars, built against SDK 55 | Vision path: `.accurate`, language correction on, passes image orientation, sorts lines top-to-bottom then left-to-right. iOS 16.0 podspec (≤ SDK 57's 16.4, so `expo-build-properties` shouldn't be needed; verify). Known bug: box sizes aren't swapped for 90°-rotated images. We avoid it by recognizing the resized (re-rendered) image. |
| `expo-text-extractor` 2.0.0 (2026-02-28) | Apple Vision; ML Kit on Android | **No:** `extractTextFromImage(uri): Promise<string[]>` | 1 maintainer, built against SDK 54 | The Swift source builds `VNImageRequestHandler(cgImage:)` **without the image orientation**, so portrait iPhone photos are read sideways unless pre-rotated. Without boxes we can't re-pair item names with prices that Vision returns as separate pieces. |
| `@react-native-ml-kit/text-recognition` 2.0.0 (2025-09-01) | **Google ML Kit on iOS** (not Vision, so it conflicts with ADR 0010) | Yes (`frame` on blocks and lines) | Not an Expo module; New Architecture not stated | Needs ML Kit pods on iOS, which exclude the arm64 simulator slice |
| `expo-ocr-kit` 0.1.4 (2026-04) | Vision / ML Kit | Blocks only | 5 versions in 5 days, 1 maintainer | Too new; block granularity |
| Own local Expo module (`modules/receipt-ocr`, ~80 lines Swift) | Apple Vision | Yes (we control it) | Ours | No third-party risk, but it's native code the user maintains. **Fallback if the Task 1 gate fails.** |

**Why `expo-mlkit-ocr`:** it is the only maintained Expo module that uses Apple Vision on iOS (matching ADR 0010), returns **line-level bounding boxes**, and handles orientation. Boxes matter for receipts: Vision often returns "Burger" and "12.99" as two separate observations when they're far apart, and the boxes let the parser put them back on the same row. The risk is a small, single-maintainer package not tested on SDK 57. That's why Task 1 is a gate, and our own module is the fallback (Task F, A1.2).

Evidence: npm registry metadata for each package; `expo-text-extractor` `ios/ExpoTextExtractorModule.swift` and `package.json` (`expo ^54`); `expo-mlkit-ocr` `ios/ExpoMlkitOcrModule.swift`, `ios/ExpoMlkitOcr.podspec`, `plugins/withMlkitSimulatorArm64Fix.js` and `package.json` (`expo ^55.0.18`); Expo SDK 57 docs for image-picker, image-manipulator and camera; Expo SDK reference table (SDK 57: iOS 16.4+, Xcode 26.4+).

## In scope
- A "Scan receipt" button on home that goes to a scan screen.
- **Native:** the camera permission flow (granted / denied, can ask again / blocked, which opens Settings), then the system camera, a resize step, on-device recognition, the parser, and the bill form prefilled with the result. Temporary image files are deleted afterwards.
- **Web (and "Type it instead" on native):** the same bill form, starting empty. This lets QA check manual entry and the live totals check without a device.
- `lib/receiptText.ts`: a pure, test-first parser with fixture receipts.
- `lib/textRecognition*`: the recognition interface, the native implementation, the web stub, and a fake.
- `lib/billDraft.ts`: the pure form model (draft state, a reducer for add/edit/delete, validation, and the live totals check reusing `checkTotals`).
- `components/BillForm.tsx` on `app/(app)/bill.tsx`: one editable form for both entry modes. Rows have name, qty, price and note, and can be added, edited and deleted. There are fields for subtotal, discounts, tax, fees, tip and total, an "Items add up to $X" line, and the review banner, all of which update as you type. Nothing is saved.
- Docs: ADR 0012 (library choice + not committing `ios/`/`android/`), updates to the existing concept note `docs/learning/concepts/on-device-ocr.md`, and the device-run steps in `CLAUDE.md` Commands are checked.

## Out of scope (explicitly cut)
- **Any DB write.** No `bills`, `line_items` or `parse_runs` tables, no migration, no RLS work. Saving the parsed bill is the next slice (M1b). Reason: the schema (bills/line_items/claims) should be designed once, with M2 claiming in view. This slice's risk is all on the device and in the parser, which needs no table.
- **Uploading or storing the photo** (Storage, signed URLs, 30-day deletion). Nothing leaves the phone in this slice.
- **Saving the form** (a Save button, drafts that survive an app restart or page reload). The draft lives in memory only; M1b adds Save together with the tables.
- Reordering rows, splitting one item into several, per-person split math, and keeping a per-row unit price separate from the line price.
- Picking from the photo library, multi-page or long-receipt stitching, a custom viewfinder or crop.
- ~~Web OCR (Tesseract.js).~~ Now in scope as Task 9 (Amendment A3): the user decided to add it, provisionally.
- Android device testing (the code path exists and is unit-tested; no device check).
- OCR character fixes (`O`→`0`, `S`→`5`), non-US formats (`12,99`, other currencies), multiple languages.
- The receipt-eval script and the dev-only "Copy recognized text" button (deferred to the next slice, A1.5).
- Claude or any server-side parsing.

## Types (the contract between tasks)
Put these in `lib/receiptTypes.ts` so the recognition and parser tasks can proceed in parallel.

```ts
export type Box = { x: number; y: number; width: number; height: number }; // image pixels, top-left origin
export type RecognizedLine = { text: string; box?: Box };
export type RecognizedText = { lines: RecognizedLine[] };          // in the order the recognizer returned them

export type ParsedItem = {
  name: string;               // trimmed, modifiers not included
  qty: number;                // integer >= 1
  unitCents: number | null;   // printed unit price, or totalCents / qty when exact, else null
  totalCents: number;         // the line's price including priced modifiers
  modifiers: string[];        // e.g. ["avocado", "no onions"]; shown in the form as the note "avocado, no onions"
  flags?: 'qty_price_mismatch'[]; // set by the parser when the printed qty × unit ≠ line price
};
export type Discount = { label: string; cents: number /* positive */; appliesTo: 'subtotal' | 'total' };
export type ReviewReason =
  | 'no_items' | 'missing_subtotal' | 'missing_total'
  | 'items_vs_subtotal' | 'subtotal_vs_total' | 'qty_price_mismatch';
export type ParsedReceipt = {
  items: ParsedItem[];
  subtotalCents: number | null;
  taxCents: number | null;     // sum of all tax lines
  tipCents: number | null;     // null = no tip line found (not the same as 0)
  feesCents: number | null;    // service charge / service fee
  discounts: Discount[];
  totalCents: number | null;
  needsReview: boolean;        // true iff reasons.length > 0
  reasons: ReviewReason[];
};
```

Form model (Task 5, in `lib/billDraft.ts`). Form fields hold **the strings the user typed**, so a half-typed `12.` isn't lost. Cents are only ever computed from those strings by `lib/money.ts`.

```ts
export type TotalField = 'subtotal' | 'tax' | 'fees' | 'tip' | 'total';
export type DraftItem = {
  id: string; name: string; qty: string; price: string; note: string;  // price = line price (qty already included)
  flagged: boolean;                                                     // parser qty_price_mismatch; cleared when the row is edited
};
export type DraftDiscount = { id: string; label: string; amount: string; appliesTo: 'subtotal' | 'total' };
export type BillDraft = {
  source: 'scan' | 'manual';
  items: DraftItem[]; discounts: DraftDiscount[];
  totals: Record<TotalField, string>;
  nextId: number;                     // ids are `i1`, `i2`, … / `d1`, … so tests are deterministic
};
export type FieldError = 'name_required' | 'price_required' | 'invalid_money' | 'too_large' | 'invalid_qty';
export type DraftEvaluation = {
  receipt: ParsedReceipt;             // built from the valid fields only; invalid or blank fields count as missing
  errors: Record<string, FieldError>; // key `${rowId}.${field}` or `totals.${TotalField}`
  itemsTotalCents: number;            // Σ valid item prices
  mismatches: ReviewReason[];         // items_vs_subtotal | subtotal_vs_total | qty_price_mismatch → red banner
  missing: ReviewReason[];            // no_items | missing_subtotal | missing_total → neutral hint, not the banner
};
```

## Tasks
Order (A1):
- **Track A (native):** Task 1, then D1 (the user's device gate), then Task 2. If D1 fails, Task F runs, and Task 2 wraps our own module instead.
- **Track B (logic + form, no device needed):** Task 3, then Task 4, then Task 5, then Task 6. It starts in parallel with Task 1.
- **Join:** Task 7 needs Tasks 2 and 6.
- **Docs:** Task 8 can start once the D1 result is known (or Task F is done), and must finish before the slice closes.
- **Web scanning (A3):** Task 9 runs after Task 7. It doesn't need a device or D1.

| # | Agent | Needs |
|---|---|---|
| 1 | native-mobile | none |
| F | native-mobile | Task 1, and only if D1 fails |
| 2 | native-mobile | Task 1 (or F) |
| 3 | implementer | none |
| 4 | implementer | Task 3 |
| 5 | implementer | Task 4 |
| 6 | implementer | Task 5 |
| 7 | implementer | Tasks 2 and 6 |
| 8 | docs-writer | the D1 result (plus the Task 9 result for the Tesseract.js part) |
| 9 | native-mobile | Task 7 (A3) |

### Task 1 (native-mobile): dependencies, config, build gate
- `npx expo install expo-image-picker expo-image-manipulator expo-file-system expo-mlkit-ocr`. Report the exact versions installed. If `npx expo install` refuses or picks a version other than 0.2.x for `expo-mlkit-ocr`, stop and report.
- `app.json` plugins:
  - `["expo-image-picker", { "cameraPermission": "SplitIt uses the camera to take a photo of your receipt. The photo is read on your phone and isn't uploaded.", "microphonePermission": false }]`. Leave `photosPermission` out, or set it to `false` if the installed plugin adds a default photo-library string (verify against the installed plugin).
  - `["expo-mlkit-ocr", { "iosEngine": "vision" }]`
  - Add `expo-build-properties` **only if** prebuild/pod install fails on the deployment target. SDK 57's 16.4 floor already exceeds the package's 16.0.
- `ios.bundleIdentifier` and `android.package` are both `com.yashs3090.splitit` (A1.1).
- `.gitignore`: add `/ios` and `/android` (Continuous Native Generation: native folders are regenerated from `app.json`. See ADR 0012.)
- Run `npx expo-doctor`, `npm run typecheck` and `npm test`.
- **Gate:** the user runs D1 (build and launch on the iPhone). If the build fails because of `expo-mlkit-ocr`, report the error, then run Task F (already approved, A1.2).
- Files: `package.json`, `package-lock.json`, `app.json`, `.gitignore`. About 30 lines, excluding the lockfile.

### Task F (native-mobile, conditional: only if D1 fails because of `expo-mlkit-ocr`): our own Vision module
Pre-approved by the user (A1.2). It keeps the `TextRecognizer` contract, so Tasks 3–7 don't change.
- Remove `expo-mlkit-ocr` from `package.json` and its plugin from `app.json`.
- Scaffold a local module with `npx create-expo-module@latest --local` (verify the flag against the installed CLI) as `modules/receipt-ocr`, iOS only.
- **Swift** (`ReceiptOcrModule.swift`, target about 80–120 lines). `AsyncFunction("recognize") { (uri: URL) -> [[String: Any]] }`:
  - Load `UIImage` from the file URL. If that fails, throw an `Exception` named `IMAGE_LOAD_FAILED`.
  - Build `VNImageRequestHandler(cgImage:orientation:)` **with the orientation mapped from `UIImage.imageOrientation`**.
  - Configure `VNRecognizeTextRequest` with `recognitionLevel = .accurate`, `usesLanguageCorrection = false` (so digits aren't "corrected"; open to tuning in D3) and `recognitionLanguages = ["en-US"]`.
  - Run the request off the main thread.
  - Return one entry per observation: `{ text: topCandidates(1).first.string, box: { x, y, width, height } }`. Boxes are in **upright** image pixels with a top-left origin. Use the oriented width and height (swapped for 90° and 270° orientations) when denormalizing, and flip y. The library had this bug; we fix it.
- **JS:** `modules/receipt-ocr/index.ts` exports `recognize(uri): Promise<{ text: string; box: Box }[]>` via `requireNativeModule('ReceiptOcr')`. There's no web or Android native code.
- **`lib/textRecognition.native.ts`** (Task 2's file) wraps this module instead.
  - `isAvailable()` is `Platform.OS === 'ios'`. Android falls back to the manual form; note this in the report and ADR 0012.
  - `mapOcrResult` becomes a pass-through of `{text, box}`. Error mapping is unchanged.
- **Box math stays in Swift.** Jest can't run it: a Jest test only checks that `mapOcrResult` passes boxes through, and D4 checks that the boxes are correct on rotated photos.
- **Gate:** the user re-runs D1, then D4.
- Files: `modules/receipt-ocr/**` (generated scaffold plus our Swift and TS), `package.json`, `app.json`, `lib/textRecognition.native.ts`, tests. Our own code is about 200 lines.

### Task 2 (native-mobile): recognition interface + per-platform implementations
- `lib/textRecognition.ts`: exports the interface type only.
  ```ts
  export type TextRecognizer = {
    isAvailable(): boolean;                               // false on web
    recognize(imageUri: string): Promise<RecognizedText>; // throws RecognitionError
  };
  export class RecognitionError extends Error { code: 'unavailable' | 'image_load_failed' | 'failed' }
  ```
- `lib/textRecognition.native.ts`: wraps `expo-mlkit-ocr`. Map `blocks[].lines[]` to `RecognizedLine` (text + box), flattening across blocks in returned order. Map library errors (e.g. `IMAGE_LOAD_FAILED`) to `RecognitionError` codes. Also export a pure `mapOcrResult(result)` for tests.
- `lib/textRecognition.web.ts`: `isAvailable() → false`, and `recognize` throws `RecognitionError('unavailable')`. **Must not import `expo-mlkit-ocr`.**
- `lib/prepareImage.ts` (native): `prepareForRecognition(uri)` resizes so the long edge is at most `RECOGNITION_MAX_EDGE = 2048` px (a constant, so it can be tuned; never upscales), saves JPEG at `compress: 0.9`, and returns `{ uri, width, height }`. `deleteTempImages(uris)` deletes files best effort via `expo-file-system` and never throws. Keep the size math in a pure function `targetSize(w, h, maxEdge)` and test it.
- `test-utils/fakeRecognizer.ts`: `createFakeRecognizer({ available, result | error })` that records calls.
- Tests: `lib/textRecognition.native.test.ts` (mock `expo-mlkit-ocr`: mapping, multi-block flattening, error mapping), `lib/textRecognition.web.test.ts` (import the `.web` file by path: unavailable, throws `unavailable`, and `jest.mock('expo-mlkit-ocr')` factory never invoked), `lib/prepareImage.test.ts` (`targetSize` cases).
- Files: the 4 `lib/` files above, `test-utils/fakeRecognizer.ts`, 3 test files. About 250 lines.

### Task 3 (implementer): types, money tokens, row grouping (test-first)
- `lib/receiptTypes.ts` (the types above).
- `lib/money.ts`:
  - `parseMoneyToken(s): number | null` accepts `12.99`, `$12.99`, `$ 12.99`, `1,234.50`, `-2.00`, `-$2.00`, `(2.00)`, `2.00-`. Negatives come back negative. It requires exactly two decimals and rejects `12`, `12.9`, `12.999`, `12,99` and `1.2.3`. It works in **integer arithmetic on the digit string, never `parseFloat` × 100**.
  - `formatCents(n)` turns `1299` into `$12.99`, `-250` into `-$2.50` and `0` into `$0.00`.
  - (A1) `parseMoneyInput(s): number | null` is for **form fields**, so it's more lenient than receipt tokens. It trims, and accepts an optional leading `$`, digits with correctly grouped commas, and an optional `.` with 0–2 decimals: `12` → 1200, `12.5` → 1250, `12.` → 1200, `.99` → 99, `$1,234.50` → 123450, `0` → 0. It returns null for an empty or blank string, `-5`, `(5.00)`, `12.999`, `1,23.00`, `abc`, `1e3`, `12 50`, `NaN`, `Infinity` and `.`. Values above `MAX_INPUT_CENTS = 9_999_999` ($99,999.99) return null too; the caller reports `too_large` by checking `isTooLarge(s)`. Integer string math only.
  - (A1) `formatCentsInput(n)` gives the string to show in a form field: 1299 → `12.99`, 5 → `0.05`, 123450 → `1234.50`. There's no `$` or commas, and it round-trips through `parseMoneyInput`.
- `lib/receiptRows.ts`: `toRows(text: RecognizedText): string[]`.
  - **With boxes:** group lines whose vertical centres are within half the median line height. Sort groups top to bottom and lines within a group left to right, then join with a single space.
  - **With no boxes:** return each line's text as-is, in order.
  - Trim and collapse whitespace; drop empty rows.
- Tests: `lib/money.test.ts`, `lib/receiptRows.test.ts`. Include a Vision-style case where the names come first and the prices after (separate observations, same y), and `toRows` pairs them correctly.
- Files: 3 source + 2 test files. About 300 lines with the A1 money-input functions.

### Task 4 (implementer): `lib/receiptText.ts` parser + totals check (test-first)
- `parseReceipt(text: RecognizedText): ParsedReceipt`, built on `toRows` and `parseMoneyToken`. It is pure, deterministic and never throws.
- `checkTotals(r): ReviewReason[]`, exported separately and tested on its own.
- Rules (case-insensitive):
  - **Price** = the last money token on the row. Any other text is the label.
  - **Totals keywords:**
    - `subtotal|sub total|sub-total|food total` → subtotal.
    - `tax|sales tax|hst|gst|vat`: sum all tax rows.
    - `tip|gratuity`, unless the row has a `%` **and** sits in a suggested-tip block (below) → tip.
    - `service charge|service fee` → fees.
    - `total|amount due|balance due|grand total` (not subtotal) → total. If there are several, the **last** one wins.
  - **Discount** = a row with a negative price, or a label matching `discount|coupon|promo|comp|happy hour|off`. If it appears before the subtotal row, it's `appliesTo: 'subtotal'`; otherwise `'total'`. Stored as positive cents.
  - **Ignored rows** (never items):
    - Payment and change: `visa|mastercard|amex|discover|card|cash|change|tendered|auth|approval`, `x{2,}\d{4}`, `\*{2,}\d{4}`.
    - Any row with a date, time or phone pattern and no price.
    - `server|table|guests|check #|order #` rows.
    - Every row in a **suggested-tip block**: from a header matching `suggested|tip guide|gratuity guide` through the following rows that start with or contain `\d{1,2}%`.
    - Rows after the total that aren't tip, fees or total.
  - **Items:** a priced row before the subtotal (or before the first totals row if there's no subtotal) that isn't a discount or ignored.
    - Quantity forms: `2 x Burger`, `2x Burger`, `2 Burger` (leading integer 1–99 followed by a space and a letter), and `Burger 2 @ 12.99 25.98`.
    - With `@ unit`: if `qty × unit ≠ total`, add `qty_price_mismatch` to `reasons` and to that item's `flags`.
  - **Modifiers:** a row starting with `+`, `add `, or `-`/`no ` followed by a word (not a number), right after an item.
    - Unpriced: append to the previous item's `modifiers`.
    - Priced: append **and add its cents to the previous item's `totalCents`**, then recompute `unitCents` (null if not exact). Decided in A1.4: the modifier text is kept (the form shows it as the item's note).
    - A modifier with no previous item is ignored.
- `checkTotals`. Tolerance is |diff| ≤ 1 cent per check. Missing tax, tip and fees count as 0.
  - `items.length === 0` → `no_items`.
  - `subtotalCents === null` → `missing_subtotal` (the items-vs-subtotal check is skipped).
  - `totalCents === null` → `missing_total`.
  - `Σ items.totalCents − Σ discounts(subtotal)` vs `subtotalCents` → `items_vs_subtotal`.
  - `subtotal + tax + fees + tip − Σ discounts(total)` vs `totalCents` → `subtotal_vs_total`.
  - `needsReview = reasons.length > 0`.
- Fixtures: `lib/fixtures/receipts.ts`, **synthetic** (no real names, card digits or addresses), each with its `RecognizedText` and its expected `ParsedReceipt`:
  1. `diner-simple`: 3 items with `$`, subtotal, tax, tip, total. Reconciles.
  2. `qty-and-at`: `2 x Burger 25.98`, `3 Fries 11.97`, `Soda 2 @ 2.50 5.00`.
  3. `modifiers`: `Bowl 11.50` / `+ avocado 1.50` / `no onions`, so Bowl = 1300 with 2 modifiers.
  4. `discount-before-subtotal`: `Happy Hour -3.00` above the subtotal.
  5. `discount-after-subtotal`: `Coupon (5.00)` between subtotal and total.
  6. `no-tip-no-dollar`: prices without `$`, no tip row. `tipCents === null`, and it reconciles.
  7. `suggested-tip-block`: `Suggested gratuity` / `18% 9.00` / `20% 10.00` / `22% 11.00` after the total. `tipCents === null`, and none of these rows become items.
  8. `two-taxes-service-charge`: state + city tax summed, `Service charge 18% 12.60` → fees.
  9. `card-slip-noise`: `VISA XXXX1234`, `Auth 012345`, `Server: Sam`, `Table 12`, a date and a phone number. None become items.
  10. `vision-columns`: names and prices as separate observations with boxes, out of order. It must parse the same as the equivalent box-less receipt.
  11. `does-not-add-up`: items 1 cent off the subtotal (passes), and a variant 2 cents off (`items_vs_subtotal`).
  12. `missing-total`: no total row, so `missing_total` and `needsReview`.
- Tests: `lib/receiptText.test.ts`. A table-driven test runs every fixture, plus focused tests for `checkTotals` boundaries.
- Files: `lib/receiptText.ts`, `lib/fixtures/receipts.ts`, `lib/receiptText.test.ts`. The parser is about 200 lines. If fixtures and tests push the total past 300, split fixtures 7–12 into a follow-up pass of the same task.

### Task 5 (implementer): bill draft model, pure (test-first)
- `lib/billDraft.ts`, with the types from "Form model" above:
  - `emptyDraft(): BillDraft` gives `source: 'manual'`, no rows and all totals `''`.
  - `fromParsed(p: ParsedReceipt): BillDraft` gives `source: 'scan'`. Each item becomes `{ name, qty: String(qty), price: formatCentsInput(totalCents), note: modifiers.join(', '), flagged: flags includes qty_price_mismatch }`. Each discount becomes `{ label, amount: formatCentsInput(cents), appliesTo }`. Each total becomes `formatCentsInput(v)`, or `''` when null.
  - `draftReducer(d, action)` handles these actions:
    - `addItem` adds `{ name:'', qty:'1', price:'', note:'' }`.
    - `updateItem(id, patch)` also sets `flagged: false`.
    - `removeItem(id)`.
    - `addDiscount` adds `appliesTo: 'subtotal'`. Also `updateDiscount(id, patch)` and `removeDiscount(id)`.
    - `setTotal(field, value)`.
    - `reset(draft)`.
    - Unknown ids are no-ops. The reducer never mutates its input.
  - `evaluateDraft(d): DraftEvaluation`:
    - **Item row:**
      - A row whose name, price and note are all blank is ignored, so a just-added row shows no errors.
      - Price present but no name: `name_required`.
      - Name present but no price: `price_required`.
      - Price fails `parseMoneyInput`: `invalid_money` (or `too_large`).
      - Qty must be an integer 1–99 with digits only; otherwise `invalid_qty`.
      - A row with any error is left out of `receipt.items` and `itemsTotalCents`.
      - Valid rows become a `ParsedItem` with `totalCents` = price, `unitCents` = price ÷ qty when exact, else null, and `modifiers` = the note split on `,` and trimmed, with blanks dropped.
    - **Discount row:**
      - Blank label and amount: ignored.
      - Otherwise the amount must parse (`invalid_money` / `too_large` / `price_required`).
      - A blank label becomes `"Discount"`.
    - **Totals fields:** blank means null (no error); invalid means `invalid_money` / `too_large`, treated as null.
    - **Reasons:** take them from `checkTotals(receipt)` (Task 4, unchanged) plus `qty_price_mismatch` if any valid item is still `flagged`. Split them into `mismatches` (red banner) and `missing` (neutral hint).
  - `FIELD_ERROR_COPY: Record<FieldError, string>` holds fixed app copy:
    - `name_required`: "Add a name."
    - `price_required`: "Add a price."
    - `invalid_money`: "Enter an amount like 12.99."
    - `too_large`: "That amount is too large."
    - `invalid_qty`: "Use a whole number from 1 to 99."
  - `REASON_COPY: Record<ReviewReason, string>` holds fixed copy for each reason. For example, `items_vs_subtotal` is "The items don't add up to the subtotal." and `missing_total` is "Enter the total from the receipt to check it."
- Tests: `lib/billDraft.test.ts`.
- Files: `lib/billDraft.ts`, `lib/billDraft.test.ts`. About 280 lines.

### Task 6 (implementer): `BillForm` component + `/bill` screen + home entry (web-testable)
- `lib/scanSession.ts`: an in-memory, module-level holder: `setScanResult(r: ParsedReceipt)`, `getScanResult(): ParsedReceipt | null`, `clearScanResult()`, with a test. **Receipt data is never put in route params or URLs** (they'd land in web history and logs).
- `components/BillForm.tsx`: `BillForm({ initial: BillDraft })` keeps the draft in `useReducer(draftReducer, initial)` and calls `evaluateDraft` on every render. Rendering logic only; all rules live in `lib/billDraft.ts`.
  - **Item rows:** `TextInput`s for Name, Qty (`keyboardType="number-pad"`), Price (`keyboardType="decimal-pad"`) and Note, plus a "Delete" button. Each input has an `accessibilityLabel` like `Item 1 name` / `Item 1 price`, so tests and screen readers can find it. "Add item" adds a row.
  - **Discount rows:** Label, Amount, a two-option toggle "Before subtotal" / "After subtotal", and "Delete". "Add discount" adds a row.
  - **Totals:** fields for Subtotal, Tax, Fees, Tip and Total. A blank field shows the placeholder "Not on receipt", never `$0.00`.
  - **Validation display:**
    - Each field with an error shows `FIELD_ERROR_COPY[code]` under it (`accessibilityRole="alert"`).
    - "Items add up to {formatCents(itemsTotalCents)}" is always shown.
    - When `mismatches` is non-empty, the banner reads "These numbers don't add up. Check them against the receipt." followed by `REASON_COPY` for each mismatch.
    - When `missing` is non-empty, a neutral hint lists `REASON_COPY` for each missing item.
    - A `flagged` row shows "Check this quantity and price."
  - **Security:** user and recognized text is rendered only as `Text` or `TextInput` value. No other copy comes from data.
- `app/(app)/bill.tsx`:
  - Initial draft: `getScanResult()`, then `fromParsed(...)`, else `emptyDraft()` (manual).
  - Title: "Check the items" (scan) or "Enter the items" (manual).
  - "Start over" calls `clearScanResult()` and replaces the route with `/scan`.
  - There's no Save button. A line says "Saving comes in the next update." (M1b).
- `app/(app)/index.tsx`: add a "Scan receipt" button that goes to `/scan`. Keep the existing sign-out button and text.
- Tests: `__tests__/billForm.test.tsx` (`renderRouter` with signed-in fakes; render `/bill` directly, with and without a `setScanResult` beforehand) covers criteria 27–36.
- Files: `lib/scanSession.ts` (+ test), `components/BillForm.tsx`, `app/(app)/bill.tsx`, `app/(app)/index.tsx`, `__tests__/billForm.test.tsx`. About 300 lines. If it goes over, move the discount rows into `components/DiscountRows.tsx`.

### Task 7 (implementer): scan screen + permission flow (joins Track A and B)
- `lib/cameraPermission.ts`: pure `permissionState(resp: { granted: boolean; canAskAgain: boolean }): 'granted' | 'ask' | 'blocked'`, with tests.
- `lib/recognizer.ts`: exports the platform `TextRecognizer` instance (re-exported from the platform file) so router tests can `jest.mock('@/lib/recognizer')` with the fake.
- `app/(app)/scan.tsx`:
  - **The screen branches on `recognizer.isAvailable()`, not on `Platform.OS`**, so both branches are testable.
  - **Available:**
    - "Take photo" requests camera permission. The states are:
      - `granted`: launch the camera.
      - `ask` (denied but can ask again): "SplitIt needs the camera to read your receipt." with a "Try again" button.
      - `blocked`: "Camera access is off for SplitIt. Turn it on in Settings." with an "Open Settings" button (`Linking.openSettings()` from `react-native`).
    - After capture: show "Reading receipt…", then run `prepareForRecognition`, `recognize`, `parseReceipt` and `setScanResult`, then `router.push('/bill')`. In a `finally`, call `deleteTempImages([captured, resized])`.
    - Camera cancelled: stay on the screen with no error.
    - `RecognitionError`, or zero recognized lines: "Couldn't read that photo. Try again with the receipt flat and well lit, or enter the items yourself." Show fixed copy only; never show the error message text.
    - "Type it instead" calls `clearScanResult()` and pushes `/bill` (the empty form).
  - **Not available (web):** "Scanning works in the iPhone app. You can enter the items yourself." with an "Enter items" button (same action as "Type it instead").
  - **Privacy:** no `console.*` calls with recognized text, parsed results or image URIs.
- `__tests__/scanFlow.test.tsx` (`renderRouter`, with Supabase, storage, `@/lib/recognizer`, `expo-image-picker`, `@/lib/prepareImage` and `Linking.openSettings` mocked, and a signed-in fake session) covers criteria 37–43.
- Files: `lib/cameraPermission.ts` (+ test), `lib/recognizer.ts`, `app/(app)/scan.tsx`, `__tests__/scanFlow.test.tsx`. About 280 lines.

### Task 8 (docs-writer): ADR + concept note + commands
- `docs/learning/decisions/0012-receipt-capture-and-recognition-libraries.md` covers:
  - `expo-image-picker` over `expo-camera`.
  - `expo-mlkit-ocr` (Vision engine) over the alternatives (paste the table above).
  - The D1 gate result, and Task F's outcome if it ran.
  - Why `ios/`/`android/` aren't committed (CNG).
  - (A3) Tesseract.js on web, **provisional pending the receipt eval**: version, self-hosted vs CDN assets (and the user's answer to A3 open question 1), and lazy loading. If the assets stay on a CDN, add a "Before production" item: self-host or justify the third-party request.
  - Update `docs/learning/decisions/README.md`.
- `docs/learning/concepts/on-device-ocr.md` already exists; update it and link real code. Cover:
  - What Vision returns: observations, boxes, normalized coordinates and orientation.
  - Why boxes help pair names and prices.
  - How the totals check catches misreads.
  - (A1) Why form fields hold strings and only `lib/money.ts` turns them into cents. If that's better as a short section in `money-and-rounding.md`, put it there and link it.
- `CLAUDE.md` § Commands: if the device-run steps need changes after D1 (e.g. Xcode ≥ 26.4, iPhone Developer Mode, trusting the developer profile under Settings → General → VPN & Device Management), **propose** the diff for the user to approve; don't apply it. Also propose updating "Web has no on-device recognition, so the host types items by hand" if the wording no longer matches the form.
- Files: 1 new ADR, 1 or 2 updated concept notes, `docs/learning/decisions/README.md`. The `CLAUDE.md` change is proposal only.

## Acceptance criteria
Tags: **[auto]** = QA checks it without a device. **[device]** = the user checks it on their iPhone (see the separate list). QA reports [device] items as NOT VERIFIED.

### Build and config [auto]
1. `npm run typecheck` exits 0, `npm test` exits 0, and `npx expo-doctor` reports no failed checks. Any warning is listed with a reason.
2. `package.json` contains `expo-image-picker` (57.x), `expo-image-manipulator` (57.x), `expo-file-system` (57.x) and `expo-mlkit-ocr` (0.2.x), all added with `npx expo install`. If Task F ran, it contains no `expo-mlkit-ocr`, and `modules/receipt-ocr` exists instead.
3. `app.json` has the `expo-image-picker` plugin with a plain-language `cameraPermission` that says the photo is read on the phone and not uploaded, and `microphonePermission: false`. It has `expo-mlkit-ocr` with `iosEngine: "vision"` (not if Task F ran). `ios.bundleIdentifier` and `android.package` are both `com.yashs3090.splitit`. `npx expo config --type introspect` (verify the flag against the installed CLI; if it's unavailable, inspect `npx expo config --json`) shows `NSCameraUsageDescription` with that text, and shows **no** `NSMicrophoneUsageDescription` or `NSPhotoLibraryUsageDescription` added by our plugins. Report anything a plugin adds by default.
4. `.gitignore` contains `/ios` and `/android`, and there's no `ios/` or `android/` directory in the repo.
5. `npm run export:web` (env vars passed inline, per lessons) exits 0. `grep -rE "service_role|sb_secret_" dist/` prints nothing, and `grep -rlE "ExpoMlkitOcr|ReceiptOcr" dist/` prints nothing (no native OCR module in the web bundle).

### Money parsing [auto], `lib/money.test.ts`
6. `parseMoneyToken` returns 1299 for `12.99`, `$12.99` and `$ 12.99`; 123450 for `1,234.50`; −200 for `-2.00`, `-$2.00`, `(2.00)` and `2.00-`; 1 for `0.01`; and 0 for `0.00`. It returns null for `12`, `12.9`, `12.999`, `12,99`, `1.2.3`, `abc` and `""`. A test asserts that `0.29`, `0.57`, `1.15` and `4.35` parse exactly (values where float × 100 goes wrong).
7. `formatCents` turns 1299 into `$12.99`, −250 into `-$2.50`, 0 into `$0.00`, 5 into `$0.05` and 123450 into `$1,234.50`.
8. (A1) `parseMoneyInput`:
   - Accepted: `12` → 1200, `12.5` → 1250, `12.` → 1200, `.99` → 99, `$1,234.50` → 123450, `0` → 0, `0.29` → 29, `4.35` → 435, `99999.99` → 9999999.
   - Null: `""`, `"  "`, `-5`, `(5.00)`, `12.999`, `1,23.00`, `abc`, `1e3`, `12 50`, `NaN`, `Infinity`, `.` and `100000.00`. `isTooLarge("100000.00")` is true and `isTooLarge("abc")` is false.
   - Round trip: for every n in [0, 1, 5, 99, 100, 1299, 123450, 9999999], `parseMoneyInput(formatCentsInput(n)) === n`.

### Rows and parser [auto], `lib/receiptRows.test.ts`, `lib/receiptText.test.ts`
9. `toRows` returns box-less input in its original order. Boxed input whose names and prices come as separate observations on the same y comes back as one row per printed line, top to bottom, name before price. Lines whose centres differ by more than one line height stay in separate rows.
10. All 12 fixtures parse to exactly their expected `ParsedReceipt` (deep equality, every money field an integer, enforced by a `Number.isInteger` assertion over all cents fields).
11. Quantity: `2 x Burger 25.98` gives qty 2, unit 1299, total 2598. `3 Fries 11.97` gives qty 3, unit 399. `Soda 2 @ 2.50 5.00` gives qty 2, unit 250, total 500. `Soda 2 @ 2.50 6.00` adds `qty_price_mismatch` to both `reasons` and the item's `flags`. A total not divisible by qty with no `@` gives `unitCents: null`.
12. Modifiers: `Bowl 11.50` + `+ avocado 1.50` + `no onions` gives one item, total 1300, modifiers `["avocado", "no onions"]`. No modifier ever becomes its own item.
13. Discounts: a discount above the subtotal has `appliesTo: 'subtotal'` and the fixture reconciles. A discount between subtotal and total has `appliesTo: 'total'` and reconciles. The cents are stored positive.
14. No-tip fixture: `tipCents === null` and `needsReview === false`. Suggested-tip fixture: `tipCents === null`, no item or tip comes from a `%` row, and `needsReview === false`.
15. Privacy/noise: in the card-slip fixture, no item name matches `/\d{4}/` from a card mask, `visa`, `auth`, `server` or `table`, and the parsed output contains no string from those rows (checked by serializing the result and searching for `1234` and `Sam`).
16. `checkTotals` boundaries: items − subtotal = ±1¢ passes and ±2¢ gives `items_vs_subtotal`. The same holds for `subtotal_vs_total` at ±1¢ / ±2¢. A missing subtotal gives `missing_subtotal` only (no `items_vs_subtotal`). A missing total gives `missing_total`. No items gives `no_items`. `needsReview` is true iff reasons is non-empty.
17. `parseReceipt` never throws: `{ lines: [] }`, 500 random-garbage lines, and lines of only symbols all return a `ParsedReceipt`, with `no_items` where relevant.

### Recognition module [auto]
18. `mapOcrResult` flattens a 2-block, 3-line mock into 3 `RecognizedLine`s in order, with boxes preserved. A mocked `IMAGE_LOAD_FAILED` rejection becomes `RecognitionError` with code `image_load_failed`, and any other rejection becomes `failed`. (If Task F ran: the same, against the `modules/receipt-ocr` mock.)
19. The web implementation: `isAvailable()` is false, `recognize()` rejects with code `unavailable`, and the native module's mock factory is never invoked when it's imported.
20. `targetSize`: 4032×3024 gives 2048×1536; 3024×4032 gives 1536×2048; 1000×800 is unchanged (never upscale); the output is always integers.
21. `permissionState`: `{granted:true}` gives `granted`; `{granted:false, canAskAgain:true}` gives `ask`; `{granted:false, canAskAgain:false}` gives `blocked`.

### Bill draft model [auto], `lib/billDraft.test.ts`
22. `emptyDraft()` evaluates to no errors, `itemsTotalCents` 0, `mismatches` `[]`, and `missing` containing `no_items`, `missing_subtotal` and `missing_total`.
23. `fromParsed(diner-simple fixture)` then `evaluateDraft` gives a `receipt` deep-equal to the fixture's expected `ParsedReceipt`: the scan → form round trip loses nothing. The `modifiers` fixture shows note `"avocado, no onions"` and price `"13.00"`. A null tip becomes `''`.
24. Reducer: `addItem` twice gives ids `i1` and `i2`, each with qty `'1'`. `updateItem('i1', {price:'4.50'})` changes only i1. `removeItem('i1')` leaves only i2. Unknown ids are no-ops. The input draft object is unchanged after each call (deep-frozen input in tests).
25. Validation:
    - A just-added blank row has no errors and isn't counted.
    - Price `12.999` gives `invalid_money`, `abc` gives `invalid_money`, `-5` gives `invalid_money`, and `100000` gives `too_large`. Each invalid row is excluded from `itemsTotalCents`.
    - Name without price gives `price_required`. Price without name gives `name_required`.
    - Qty `0`, `100`, `1.5` and `x` give `invalid_qty`.
    - An invalid Tax gives `totals.tax: invalid_money` and is treated as null.
    - Every cents value in the evaluation is `Number.isInteger`.
26. Live totals check:
    - Items 12.99 + 8.50, subtotal `21.49`, tax `1.72`, total `23.21` (tip blank) give `mismatches: []` and `missing: []`.
    - Subtotal `21.51` (2¢ off) gives `items_vs_subtotal`; `21.50` (1¢) passes.
    - A discount `3.00` before the subtotal with subtotal `18.49` passes. Switching it to `appliesTo: 'total'` gives `items_vs_subtotal`.
    - A parser-flagged item gives `qty_price_mismatch` until that row is edited, then the reason clears.

### Bill form screen (Jest router tests, `__tests__/billForm.test.tsx`) [auto]
27. Signed in, home shows "Scan receipt", and pressing it goes to `/scan`.
28. `/bill` with no scan result shows "Enter the items", no item rows, "Items add up to $0.00", the neutral hint, and no red banner.
29. **Add:** press "Add item" twice and fill `Burger` / qty `2` / `25.98` and `Fries` / `3.99`. "Items add up to $29.97" appears.
30. **Edit:** change Fries' price to `4.49`, and the line shows `$30.47`.
31. **Delete:** delete Burger. The Burger inputs are gone and the line shows `$4.49`.
32. **Invalid money is rejected:**
    - Typing `12.999` into a price shows "Enter an amount like 12.99." and doesn't change the items line. `abc` and `-5` behave the same.
    - Typing `1.5` into a qty shows "Use a whole number from 1 to 99."
    - Fixing the value removes the message.
    - At no point does the screen show `NaN`, `undefined` or `Infinity` (`queryByText(/NaN|undefined|Infinity/)` is null after each step).
33. **The totals check updates:**
    - With items totalling `$29.97`, entering subtotal `29.99` shows the red banner with "The items don't add up to the subtotal."
    - Changing the subtotal to `29.97` removes it.
    - Entering tax `2.40` and total `32.37` keeps it clear. Total `32.40` shows the subtotal-vs-total copy.
    - A blank Tip shows the placeholder "Not on receipt" and doesn't trigger the banner.
34. **Discount:** add a discount `5.00` "Before subtotal" with subtotal `24.97`, and there's no banner. Delete the discount, and the banner appears.
35. **Prefilled from a scan:** `setScanResult(parse(modifiers fixture))`, then render `/bill`.
    - It shows "Check the items" and the Bowl row with price `13.00` and note `avocado, no onions`.
    - The total fields show the parsed values.
    - Editing a price recomputes the check exactly as in criterion 33: same component, same rules.
36. "Start over" clears the result: you land on `/scan`, and going to `/bill` again shows the empty manual form. After any form interaction, `router.getPathname()` is `/bill` with empty search params (no receipt data in the URL).

### Scan flow (Jest router tests, `__tests__/scanFlow.test.tsx`) [auto]
37. With the recognizer available and permission granted, Take photo leads to the camera mock returning a URI, then the fake recognizer returning the `diner-simple` lines.
    - The app ends on `/bill`, showing "Check the items", each item name in an input, and the parsed prices.
    - There's no red banner.
    - `deleteTempImages` was called with both URIs.
    - The pathname is exactly `/bill` with empty search params.
38. Permission `ask`: the explanation and "Try again" appear, and the camera is not launched. Permission `blocked`: "Open Settings" appears and pressing it calls `Linking.openSettings` once. The camera is not launched.
39. Camera cancelled: still on `/scan`, no error text, and the recognizer not called.
40. Recognizer throws (or returns zero lines):
    - The fixed "Couldn't read that photo…" copy appears.
    - The thrown error's message text does **not** appear.
    - `deleteTempImages` is still called.
    - "Type it instead" opens the empty form.
41. Recognizer unavailable (the web branch): there's no "Take photo" button and no camera permission request. "Enter items" opens `/bill` with "Enter the items".
42. A scan of the `does-not-add-up` (2¢ off) fixture lands on `/bill` with the red banner and `items_vs_subtotal` copy.
43. After a scan, "Type it instead" (back on `/scan`) clears the previous result: `/bill` shows the empty form, not the old receipt.

### Hygiene and privacy [auto]
44. `git grep -nE "console\.(log|info|debug|warn)\(" -- lib/receipt* lib/textRecognition* lib/prepareImage.ts lib/scanSession.ts lib/billDraft.ts components/BillForm.tsx "app/(app)/scan.tsx" "app/(app)/bill.tsx"` returns nothing.
45. `git grep -nE "parseFloat|Number\(|\* ?100\b|toFixed" -- lib/money.ts lib/receiptText.ts lib/receiptRows.ts lib/billDraft.ts components/BillForm.tsx` returns nothing (no float money math; qty parsing uses a digit regex plus `parseInt(s, 10)`).
46. No file under `supabase/` changed in this slice (`git status supabase/` is clean), and there's no network call in the scan or form path (`git grep -nE "fetch\(|supabase\." -- "app/(app)/scan.tsx" "app/(app)/bill.tsx" components/BillForm.tsx lib/receipt* lib/textRecognition* lib/prepareImage.ts lib/billDraft.ts` returns nothing).
47. Fixture receipts contain no real-looking personal data: no 13–19 digit numbers and no email addresses (`grep -E "[0-9]{13,19}|@[a-z]+\." lib/fixtures/receipts.ts` returns nothing).

### Web manual check (QA, if a browser tool is available; otherwise the user)
48. `npm run web`, signed in:
    - Scan receipt shows "Scanning works in the iPhone app…", and "Enter items" opens the form.
    - Add three items, edit one and delete one. Type `12.999` into a price and see the error. Enter subtotal, tax and total until the banner clears, then change the total by 2¢ and see the banner.
    - Reloading the page loses the draft; that's expected (nothing is saved, M1b).
    - Afterwards, `git diff tsconfig.json` is clean or reverted (lessons).

## On-device checks (the user, on their iPhone)
Prerequisites: Xcode 26.4+, iPhone on iOS 16.4+ with Developer Mode on, `npx expo run:ios --device` signed with your free Apple ID (bundle id `com.yashs3090.splitit`). The first launch may need Settings → General → VPN & Device Management → trust your developer certificate.

- **D1 (gate after Task 1):** the app builds, installs and launches to sign-in/home. No red screen, no "Cannot find native module 'ExpoMlkitOcr'". If it fails, Task F runs, then D1 is repeated.
- **D2:** first tap on Take photo shows iOS's camera prompt with the text from criterion 3. Allow it, and the system camera opens.
- **D3:** take a photo of a real, flat, well-lit restaurant receipt. Within about 5 seconds, the "Check the items" form shows items. Before editing anything, write down the number of items the receipt has, how many show with the correct name and price, and whether the total matches. (This is the first real signal on the 85% threshold; please share the counts.)
- **D4:** photograph a receipt holding the phone upright (portrait). Item names appear next to the right prices, which means orientation and row pairing work. Repeat with the phone turned sideways.
- **D5:** a receipt with a tip-suggestion block, or a crumpled one: either the numbers add up, or the "don't add up" banner shows. The app never shows a wrong total silently without the banner.
- **D6:** deny access: Settings → SplitIt → Camera off, then reopen and tap Take photo. You see "Camera access is off…" and "Open Settings", which opens SplitIt's settings page. Turn access back on, return to the app, and the camera works.
- **D7:** tap Take photo, then Cancel in the camera. You're back on the scan screen with no error.
- **D8:** airplane mode on, then scan a receipt. It still works (on-device, nothing uploaded).
- **D9:** "Type it instead" opens the empty form. Adding, editing and deleting items works with the iPhone keyboard (number pad for qty, decimal pad for prices), and the keyboard doesn't hide the field you're typing in.
- **D10:** after a scan, fix one wrong price in the form, and the banner updates (clears if that was the only error).

## Risks / open questions

**Decided (Amendment A1):** bundle id `com.yashs3090.splitit`; the own Vision module is the fallback (Task F); field-based form, one component for manual entry and review; priced modifiers fold into the item with the text kept as a note; the "Copy recognized text" button is deferred.

**Still open (no decision needed now)**
- **Image size for recognition:** I set the long edge to 2048 px (a constant). Larger can read small print better but is slower. Tune it from the D3/D4 results.
- **Price field means the line price** (what the receipt prints, qty already included), not the unit price. That matches receipts and the parser. If the user prefers "price each", it's a small `evaluateDraft` change. Raise it if D9 feels wrong.

**Technical risks**
- **No candidate library declares SDK 57 support.** `expo-mlkit-ocr` was built against SDK 55 and has one maintainer. Mitigation: the D1 gate plus Task F. Pin the exact installed version.
- **Task F is iOS-only:** if it runs, Android has no recognition and uses the manual form. That's fine for now, since Android device testing is out of scope.
- **Orientation and boxes:** `expo-mlkit-ocr`'s Vision path doesn't swap box width/height for 90°-rotated images. We recognize the re-rendered output of `expo-image-manipulator` instead, which *should* be upright, but the docs don't confirm this. D4 checks it.
- **Vision language correction** is on in the library and could "correct" item names or digits. If D3 shows digit errors, that's an argument for Task F (which turns it off) even if D1 passes. That's the user's call.
- **Parser accuracy is unknown** until D3. Synthetic fixtures test our rules, not real-world coverage. The 85% threshold in ADR 0010 can't be measured until the eval slice.
- **The form on a small phone screen:** many inputs. Keep the layout a simple `ScrollView` with `keyboardShouldPersistTaps="handled"` and `KeyboardAvoidingView`. D9 checks it; there's no design polish in this slice.
- **Free Apple ID limits:** a 7-day install expiry and 3 apps. If testing stretches past a week, re-run `npx expo run:ios --device`.
- **`npm run web` may rewrite `tsconfig.json`** (lessons). Revert the generated includes after criterion 48.
- **Doc drift:** resolved 2026-11-20 (ADR 0011 single repo; CLAUDE.md and ADR 0010 updated).

## Amendment A2 (2026-11-20): user decisions after review of Tasks 3–4
1. **No-subtotal cross-check (review R2).** When a receipt has no subtotal line, the parser checks Σitems − discounts + tax + fees + tip against the total (±1¢). A mismatch raises the red-banner reason `subtotal_vs_total` (alongside the neutral `missing_subtotal` hint). Criterion 16 changes accordingly: "missing subtotal gives `missing_subtotal`, plus `subtotal_vs_total` only if items + tax + fees + tip − discounts ≠ total".
2. **Item-level discounts (review R5), user's rule.** A discount line directly underneath an item (before the subtotal, e.g. `Burger 12.00` then `Happy Hour -2.00`) is folded into that item: the item's price drops by the discount and the discount text is kept in the item's note, the same way priced modifiers fold in (A1 §4). Discount lines after the subtotal stay bill-level discounts. A priced row whose name merely *contains* a discount word (`Happy Hour Wings 8.00`, `Comp Salad 0.00`) is an item, not a discount; a row is a discount only if its label is just discount keyword(s) or its amount is negative. If an item discount is larger than the item's price, don't go below 0: keep it as a bill-level discount and flag the item for review.

## Amendment A3 (2026-11-20): web scanning with Tesseract.js
**Decision (user):** on web, the host can take or upload a receipt photo, and it's read in the browser with **Tesseract.js**, "for now". This is **provisional**: the receipt eval may replace it. Everything else stays the same: the same `TextRecognizer` contract, the same parser and the same prefilled `/bill` form. The manual "Enter items" path stays on web. Nothing is uploaded: the image never leaves the browser.

**Earlier criteria this changes, once Task 9 lands:**
- Criterion 41 now applies only when `isAvailable()` is false (e.g. a browser without WebAssembly).
- Criterion 48's first step becomes "web shows 'Take or upload photo' and 'Enter items'".
- Criterion 19 (web recognizer unavailable) is replaced by 50–52.

### Research (verified 2026-11-20)
- **Version:** `tesseract.js` **7.0.0** (latest on npm, about 1.4 MB unpacked). It depends on `tesseract.js-core ^7.0.0`. v7 drops Node 14 and is about 15–35% faster than v6, per its release notes. Pin the exact version installed.
- **API:** create a worker with `createWorker('eng', 1 /* OEM LSTM only */, { workerPath, corePath, langPath, logger })`, then call `worker.recognize(image, {}, { blocks: true })` and `worker.terminate()`. **Since v6, everything except `text` is off by default**, so line boxes need `{ blocks: true }`. The result is `data.blocks[].paragraphs[].lines[]`, each with `text` and `bbox {x0,y0,x1,y1}` in pixels of the input image. Verify that shape against the installed version's types before mapping. An empty result is not an exception.
- **Where assets load from by default:** a public CDN (jsDelivr).
  - `workerPath` is `cdn.jsdelivr.net/npm/tesseract.js@v<version>/dist/worker.min.js`.
  - `corePath` is jsDelivr `tesseract.js-core`, via the browser adapter (verify).
  - `langPath` is `cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int` with OEM LSTM-only, or `…/4.0.0` otherwise.
  - Traineddata is cached in IndexedDB (`cacheMethod: 'write'`). That holds model data only, never receipt content.
- **Download sizes per user (first scan):**
  - Worker: small.
  - One core variant, chosen by browser features: the LSTM-only `.wasm.js` files are about 3.9 MB each (4 variants: plain, simd, relaxedsimd, plus the non-LSTM ones we don't need).
  - `eng.traineddata.gz` (`4.0.0_best_int`): about 2.95 MB. The full `4.0.0` is 10.9 MB, so use best_int with OEM 1.
  - Total: **about 7 MB on the first scan**, cached afterwards. None of this is in the initial bundle if it's loaded lazily.
- **Metro / Expo SDK 57 web:**
  - `tesseract.js` uses the package `browser` field to swap its Node worker for the browser one. Metro's web resolver honors `browser`, but this is unverified for this package.
  - `await import('tesseract.js')` should become a separate async chunk in `expo export -p web`, but that's also unverified.
  - **Both are Task 9's first gate.** If either fails, use the fallback: self-host `tesseract.min.js` in `public/` and load it with a runtime `<script>` tag, so Metro never bundles it.
- **Capture on web:**
  - `expo-image-picker` on web opens an `<input type="file">` and returns a `blob:` or `data:` URI. No camera permission API is involved, and `requestCameraPermissionsAsync` does nothing on web.
  - Mobile browsers offer "Take Photo / Photo Library / Choose File" from a plain image file input. Desktop browsers show a file chooser.
  - A file input doesn't use `getUserMedia`, so it isn't limited to https or localhost the way a live camera view is. Still, test on `localhost:8081` (desktop) and over https for phones (e.g. a tunnel), and verify against the installed version.
- **Resize on web:** `expo-image-manipulator` supports web (canvas), per the SDK 57 docs, and `renderAsync`/`saveAsync` return a web URI. `expo-file-system` file deletion doesn't apply to blob/data URIs.

### Decisions in this amendment (my recommendations; the user can override)
1. **Web shows one button, "Take or upload photo"**, using `launchImageLibraryAsync({ mediaTypes: ['images'] })` and not `launchCameraAsync`. On phones the browser's own sheet already offers the camera. On desktop a separate "Take photo" button would just open the same file chooser, so two buttons would be confusing. Native stays "Take photo" only (the photo library remains out of scope on native).
2. **OEM 1 (LSTM only) with `4.0.0_best_int` English data**, page segmentation mode `4` (a single column of text of variable sizes: receipt-like), and `preserve_interword_spaces = 1`. These are constants in one place, so the eval can tune them.
3. **One worker per scan**, terminated afterwards (or on cancel). This frees memory. The model download is cached, so the next scan costs only worker start-up.

### Open question for the user
1. **Self-host the Tesseract assets, or load them from the jsDelivr CDN?**
   - **Self-host (recommended):** copy `worker.min.js`, the LSTM core variants and `eng.traineddata.gz` into the web build. Use a script that copies them from `node_modules` (`tesseract.js`, `tesseract.js-core`, and `@tesseract.js-data/eng` as a dev dependency) into `public/tesseract/`, run before `export:web` and `web`, with `public/tesseract/` gitignored. That way nobody commits about 15 MB of binaries.
     - For: no third-party request, so jsDelivr never learns who uses the scanner or when; versions are pinned to `package-lock.json`, which means less supply-chain risk than a CDN URL; it works under a strict CSP later; and it works offline after the first load as long as our own site is cached.
     - Against: the `dist/` size grows by about 15 MB (each user downloads only about 7 MB), there's a small copy script to maintain, and we pay hosting bandwidth.
   - **CDN:** zero setup, but every first scan contacts jsDelivr, which reveals the visitor's IP and usage. Scanning fails if jsDelivr is blocked or down. If chosen, ADR 0012 gets a "Before production" item (self-host or justify it).
   - The image never leaves the browser either way.

### Task 9 (native-mobile): web text recognition with Tesseract.js
Needs Task 7. Target: about 300 lines of code plus tests. If it grows past that, split the asset-copy script into 9a and the rest into 9b.
- **Gate first:** `npx expo install tesseract.js` (or `npm i -E` if `expo install` doesn't know it), and report the exact version. Then, in a throwaway branch, prove two things:
  - (a) `await import('tesseract.js')` builds with `npm run export:web` and lands in a separate chunk.
  - (b) A recognize call works in `npm run web` on desktop Chrome.

  If (a) fails, use the `<script>` fallback above and report which was used.
- **Assets:** follow the user's answer to the open question. Until it's answered, implement **self-hosting**. Add `scripts/copy-tesseract-assets.mjs`, run from `predev`/`preweb` and `preexport:web` (or prepended in the scripts), copying to `public/tesseract/{worker.min.js, core/…, lang/eng.traineddata.gz}`, and add `public/tesseract/` to `.gitignore`. Same-origin paths are used for `workerPath`, `corePath` (the directory, per the docs) and `langPath`, with `workerBlobURL: false`.
- **`lib/textRecognition.web.ts`** implements the existing contract:
  - `isAvailable()` is true when `typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'`.
  - `recognize(uri, opts?)` loads `tesseract.js` **only via `await import(...)` inside `recognize`**, never at module top level. It creates the worker with the constants above, sets parameters, recognizes with `{ blocks: true }`, maps the result, and terminates the worker in `finally`.
  - **Pure `mapTesseractResult(data): RecognizedText`** (exported, tested):
    - Flatten `blocks → paragraphs → lines` in returned order.
    - Each line becomes `{ text: line.text.trim(), box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }`.
    - Drop empty lines, and lines with a non-finite or negative box. Missing `blocks` gives `{ lines: [] }`.
  - **It must never import `expo-mlkit-ocr`.** Native files must never import `tesseract.js`.
- **Contract extension** (in `lib/textRecognition.ts` and `lib/recognitionError.ts`). These are backward compatible: native ignores the options, and the fake records them.
  - `recognize(imageUri: string, opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal })`.
  - New `RecognitionErrorCode`s:
    - `'cancelled'`: the signal aborted; the worker is terminated.
    - `'engine_load_failed'`: the worker, core or traineddata failed to load (offline, 404, CSP).
  - Mapping:
    - Image decode failure gives `image_load_failed`.
    - Anything else gives `failed`.
  - Fixed messages only, as today.
- **Progress:** pass the Tesseract logger only to `onProgress(m.progress)` when `m.status === 'recognizing text'`. A separate "Getting the text reader ready…" state covers the loading stages (the first run downloads about 7 MB). **The logger must never `console.*` anything**, and it never forwards `m` itself.
- **`lib/prepareImage`:** split it into `prepareImage.native.ts` (the current code) and `prepareImage.web.ts`, with a shared `targetSize` in `lib/imageSize.ts`, so the web file never imports `expo-file-system`.
  - Web `prepareForRecognition` resizes the same way with `expo-image-manipulator`.
  - Web `deleteTempImages` calls `URL.revokeObjectURL` on `blob:` URIs, ignores everything else, and never throws.
  - Keep the existing tests passing (move them as needed).
- **Capture:** add `lib/capturePhoto.native.ts` / `.web.ts` (plus a `.ts` type file, same pattern as `textRecognition`). Both export `capturePhoto(): Promise<{ kind: 'photo'; uri } | { kind: 'cancelled' } | { kind: 'permission'; state: 'ask' | 'blocked' }>`.
  - Native: the Task 7 permission flow plus `launchCameraAsync`.
  - Web: `launchImageLibraryAsync({ mediaTypes: ['images'] })` with no permission step.
  - `app/(app)/scan.tsx` calls `capturePhoto()` instead of calling image-picker directly. The button label comes from the platform module (`CAPTURE_LABEL`: "Take photo" / "Take or upload photo").
  - Existing scan-flow tests keep passing, with the mock moved to `@/lib/capturePhoto`.
- **Scan screen UI** (smallest change to Task 7's screen; the designer's styles are untouched):
  - While reading, show "Reading receipt…" with a determinate progress bar (`accessibilityRole="progressbar"`, value 0–100) and a **Cancel** button that aborts. Cancel returns to idle with no error text and still calls `deleteTempImages`.
  - Errors use fixed copy:
    - `engine_load_failed`: "Couldn't load the text reader. Check your connection and try again, or enter the items yourself."
    - Others: the existing "Couldn't read that photo…" copy.
  - Web keeps the "Enter items" button next to the scan button. The "Scanning works in the iPhone app" text now shows only when `isAvailable()` is false (old browsers).
- **Tests:**
  - `lib/textRecognition.web.test.ts` (rewritten). Mock `tesseract.js` with a fake `createWorker`; assert the mock factory isn't invoked at import time, only on the first `recognize`.
  - `lib/prepareImage.web.test.ts`.
  - `lib/capturePhoto.*.test.ts`.
  - `__tests__/scanFlow.test.tsx` additions (criteria 49–58).
- **Files:**
  - `package.json` and lockfile.
  - `scripts/copy-tesseract-assets.mjs`.
  - `.gitignore`.
  - `lib/textRecognition.ts`, `lib/textRecognition.web.ts`, `lib/recognitionError.ts`.
  - `lib/prepareImage.{native,web}.ts`, `lib/imageSize.ts`.
  - `lib/capturePhoto.{ts,native.ts,web.ts}`.
  - `app/(app)/scan.tsx`.
  - Tests.

### Acceptance criteria (A3) [auto unless noted]
49. `package.json` pins `tesseract.js` 7.x (exact version reported). If self-hosting: `@tesseract.js-data/eng` is in `devDependencies`, `public/tesseract/` is gitignored, and `git ls-files public/tesseract` prints nothing.
50. `mapTesseractResult`:
    - A mock with 2 blocks × 2 paragraphs × 2 lines gives 8 lines in order, with `{x0:10,y0:20,x1:110,y1:45}` becoming `{x:10,y:20,width:100,height:25}`.
    - Whitespace-only lines are dropped. Missing `blocks` gives `{ lines: [] }`.
    - The output feeds `parseReceipt` unchanged: the `diner-simple` text laid out as Tesseract lines parses to the same items as fixture 1.
51. Web `recognize`:
    - `recognize` passes `{ blocks: true }` and calls `terminate` once on success, on error and on abort.
    - A logger event `{status:'recognizing text', progress:0.5}` calls `onProgress(0.5)`, and other statuses don't.
    - Aborting the signal rejects with code `cancelled`.
    - A rejected `createWorker` (asset load failure) rejects with `engine_load_failed`.
    - A recognize failure rejects with `failed`.
    - The error's `message` is always the fixed text: assert it doesn't contain the mock's original error message.
52. **Lazy loading:** the `tesseract.js` mock factory is not invoked when `lib/textRecognition.web.ts` is imported; it is invoked on the first `recognize`.
53. **Web bundle:** after `npm run export:web`:
    - The entry bundle(s) referenced by `dist/index.html` don't contain `tesseract` (`grep -il tesseract` over the files named in `index.html`'s `<script>` tags prints nothing).
    - Some other JS file in `dist/` does contain it (the lazy chunk), or with the `<script>` fallback, `dist/tesseract/` has it and no JS bundle does.
    - If self-hosting: `dist/tesseract/lang/eng.traineddata.gz` and the worker exist, and `grep -rl "cdn.jsdelivr.net" dist/_expo` prints nothing.
54. **Native bundles:** `npx expo export -p ios --output-dir <scratch>` and `-p android` succeed without Xcode, and `grep -ril tesseract <scratch>` prints nothing. Also, `git grep -n "tesseract" -- "*.native.ts" "app/"` prints nothing.
55. `prepareImage.web`: `deleteTempImages(['blob:x', 'data:…', 'https://x', undefined])` calls `URL.revokeObjectURL` only for `blob:x` and never throws. `git grep -n "expo-file-system" -- lib/prepareImage.web.ts lib/textRecognition.web.ts lib/capturePhoto.web.ts` prints nothing.
56. **Capture (web):** `capturePhoto()` calls `launchImageLibraryAsync` with `mediaTypes: ['images']`, never `requestCameraPermissionsAsync` or `launchCameraAsync`. Cancel gives `{kind:'cancelled'}`.
57. **Scan screen, recognizer slow (fake resolves on demand):**
    - The progress bar and "Reading receipt…" are shown, and `onProgress(0.4)` updates the bar to 40.
    - Cancel aborts: the fake sees the signal aborted. The screen is idle, shows no error text, and doesn't navigate. `deleteTempImages` was called.
58. **Scan screen errors:** `engine_load_failed` shows the "Couldn't load the text reader…" copy, and the other codes show "Couldn't read that photo…". The error's message never appears, and "Enter items" / "Type it instead" still opens the empty form.
59. **Hygiene:** `git grep -nE "console\.(log|info|debug|warn|error)\(" -- lib/textRecognition.web.ts lib/capturePhoto* lib/prepareImage*` prints nothing, and `git grep -n "logger" lib/textRecognition.web.ts` shows that only `onProgress` is called from it.
60. **Manual browser check (QA with a browser tool, otherwise the user):**
    - `npm run web`, signed in, at `localhost:8081/scan`. Press "Take or upload photo" and choose a clear receipt photo.
    - You see "Getting the text reader ready…", then a progress bar, then the prefilled "Check the items" form.
    - In DevTools → Network, no request goes to a third-party host when self-hosting, and no request uploads the image.
    - A second scan doesn't re-download `eng.traineddata`.
    - Cancel mid-read returns to the scan screen.
    - Offline (DevTools) on a fresh profile: the "Couldn't load the text reader…" copy appears.
    - Afterwards, `git diff tsconfig.json` is clean or reverted.
61. **[device, optional] Phone browser:** open the web build on the iPhone over https (tunnel). "Take or upload photo" offers the camera, and a photo reads into the form. Record the item counts like D3, as a Tesseract-vs-Vision data point for the eval.

### Risks (A3)
- **Accuracy:** Tesseract is generally weaker than Apple Vision on phone photos of receipts (curved paper, low contrast, thermal print). That's why it's provisional. The eval decides. Feeding it the resized 2048 px image is the starting point; contrast/greyscale preprocessing is out of scope unless the eval shows it's needed.
- **Speed and memory:** several seconds per receipt on mid-range phones, plus about 7 MB on the first use. The progress bar and Cancel mitigate this. If it's too slow, lower `RECOGNITION_MAX_EDGE` for web only.
- **Metro compatibility** isn't documented for SDK 57. The Task 9 gate plus the `<script>` fallback cover it.

## Amendment A4 (2026-11-21): changes from the full M1a review
1. **Tesseract page-segmentation mode is 6, not 4.** On the test receipt, modes 3 and 4 dropped every price and the Tax/Tip/Total lines. `TESSERACT_PARAMS` in `lib/webOcrEngine.ts`; the receipt eval re-checks it on real photos.
2. **Criterion 53 reworded:** "The web entry bundle contains no `tesseract`; the lazy `webOcrEngine-*` chunk does. The only `cdn.jsdelivr.net` string under `dist/_expo` is the library's built-in default `workerPath` inside that lazy chunk, which `tesseractPaths()` overrides (unit-tested: worker, core and language paths are same-origin). Criterion 60's Network-panel check confirms no third-party request."
3. **Known limitation (Tesseract.js API):** if the language data fails to download, tesseract.js never settles the worker, so that half-started worker can't be terminated and stays idle until the tab reloads. Documented in ADR 0012.
4. **QA greps:** every file is untracked, so `git grep` checks pass vacuously. QA uses plain `grep -rn` over the same paths until the first commit.

## Amendment A5 (2026-11-21): criterion 54 after QA
`expo export -p ios|android` copies the whole `public/` folder (so `public/tesseract/`, ~15 MB) into the native export folder, although no native JS bundle contains Tesseract. Criterion 54 is reworded to what it was meant to protect: "**No native JS bundle (`_expo/**` / `*.hbc`) or `metadata.json` from `expo export -p ios|android` contains `tesseract`, and no `*.native.ts` or `app/` file imports it.**" Whether the copied `public/` files would ship in a native release or an EAS Update is checked before production (`docs/before-production.md`). QA result for 54 under this wording: PASS (QA 2026-11-21: `.hbc` bundles and `metadata.json` have 0 matches).
