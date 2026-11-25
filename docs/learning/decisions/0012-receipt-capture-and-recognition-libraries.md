# 0012: Libraries for taking the receipt photo and reading its text

**Status:** Accepted (2026-11-21). Builds on [0010](0010-on-device-ocr-no-custom-backend.md), which chose on-device recognition but left the library open.

> **D1 gate: pending.** D1 is the first build of the app on the user's iPhone. It hasn't run yet because Xcode isn't installed. Until it passes, the iOS library choice below is **not proven on a real device**. **This ADR must be updated after D1** with a dated note: either "D1 passed on <date>" or "D1 failed; Task F ran; see the new ADR that supersedes the iOS part". The rest (camera, web, CNG) doesn't depend on D1.

## Context
M1a (spec: `docs/specs/2026-11-20-m1a-scan-receipt.md`) is the first slice where a host scans a real receipt. It needs three things:
1. **A way to take the photo** on iPhone and in a browser.
2. **A text recognizer** that runs where the photo is: Apple Vision on iPhone (ADR 0010), something in the browser on web.
3. **Line positions (bounding boxes)**, not just text. Vision often returns "Burger" and "12.99" as two separate pieces because they're far apart on the paper. The boxes are how the parser puts them back on the same row.

We're on Expo SDK 57 ([0009](0009-expo-sdk-57-node-20.md)). No third-party recognition library says it supports SDK 57, so every choice had to be checked against the installed versions.

## Decision 1: camera via `expo-image-picker`, not `expo-camera`
| Option | Pros | Cons |
|---|---|---|
| **`expo-image-picker` ~57.0.21** (`launchCameraAsync`) | Opens the phone's own camera screen, so we write no viewfinder code. Returns `{ canceled, assets[{ uri, width, height }] }`. The permission call returns `granted` and `canAskAgain`, which is all our "ask again / open Settings" flow needs. On web it opens a file picker, which on phones offers "Take Photo". | No custom overlay (e.g. a receipt-shaped guide) |
| `expo-camera` ~57.0.6 (`CameraView` + `takePictureAsync`) | Full control: custom viewfinder, guides | More code and state: a camera ref, "camera ready" events, temp files |

**Chosen:** `expo-image-picker`. On native the scan button calls `launchCameraAsync` (`lib/capturePhoto.native.ts`). On web it calls `launchImageLibraryAsync({ mediaTypes: ['images'] })` (`lib/capturePhoto.web.ts:16`), and the button reads "Take or upload photo".

Config (`app.json`): `cameraPermission` is a plain-language sentence ("…read on your phone and isn't uploaded"), and `microphonePermission: false` and `photosPermission: false` stop the plugin adding permissions we never use.

**Revisit when:** the system camera gives poor receipt photos and a framing guide would help.

## Decision 2: iOS recognition via `expo-mlkit-ocr` 0.2.7, Apple Vision engine
Despite the name, this package can use **Apple Vision** on iOS. With `["expo-mlkit-ocr", { "iosEngine": "vision" }]` in `app.json`, its config plugin leaves Google's ML Kit out of the iOS build entirely. On Android it uses Google ML Kit v2.

The options we compared (checked 2026-11-20 against npm metadata and each package's source):

| Candidate | iOS engine | Line bounding boxes | Maintenance | Notes |
|---|---|---|---|---|
| **`expo-mlkit-ocr` 0.2.7** (2026-05-06) | **Apple Vision** when `iosEngine` is `"vision"` or `"auto"` (the plugin sets `EXPO_MLKIT_OCR_DISABLE_MLKIT=1`, so no Google pods on iOS); ML Kit v2 on Android | **Yes:** `blocks[].lines[].{text, boundingBox{x,y,width,height}}` plus words, in image pixels, top-left origin | 1 maintainer, ~39 stars, built against SDK 55 | Vision path: `.accurate`, language correction on, passes image orientation, sorts lines top-to-bottom then left-to-right. iOS 16.0 podspec (below SDK 57's 16.4 floor, so no extra build settings needed). Known bug: box sizes aren't swapped for 90°-rotated images. We avoid it by recognizing the resized (re-rendered) image. |
| `expo-text-extractor` 2.0.0 (2026-02-28) | Apple Vision; ML Kit on Android | **No:** `extractTextFromImage(uri): Promise<string[]>` | 1 maintainer, built against SDK 54 | The Swift source builds `VNImageRequestHandler(cgImage:)` **without the image orientation**, so portrait iPhone photos are read sideways unless pre-rotated. Without boxes we can't re-pair item names with prices that Vision returns as separate pieces. |
| `@react-native-ml-kit/text-recognition` 2.0.0 (2025-09-01) | **Google ML Kit on iOS** (not Vision, so it conflicts with ADR 0010) | Yes (`frame` on blocks and lines) | Not an Expo module; New Architecture not stated | Needs ML Kit pods on iOS, which exclude the arm64 simulator slice |
| `expo-ocr-kit` 0.1.4 (2026-04) | Vision / ML Kit | Blocks only | 5 versions in 5 days, 1 maintainer | Too new; block granularity |
| Own local Expo module (`modules/receipt-ocr`, ~80 lines Swift) | Apple Vision | Yes (we control it) | Ours | No third-party risk, but it's native code the user maintains. **Fallback if the D1 gate fails.** |

**Why `expo-mlkit-ocr`:** it's the only maintained Expo module that uses Apple Vision on iOS (matching ADR 0010), returns **line-level boxes**, and handles photo orientation.

**The risk:** it's small, has one maintainer, and wasn't built for SDK 57. So:
- It's **pinned to exactly `0.2.7`** in `package.json` (no `^` or `~`), so an update can't arrive by surprise.
- It's **loaded lazily** (`lib/textRecognition.native.ts:22`). If the native code is missing (for example in Expo Go), `isAvailable()` returns false and the host gets the manual form instead of a crash at startup.
- **D1 is a gate.** If the app doesn't build or launch on the iPhone because of this package, **Task F** runs. The user approved it in advance (spec A1.2). Task F means writing our own small Expo module that calls Vision directly (`modules/receipt-ocr`), with orientation and box math fixed in Swift and language correction off. It keeps the same `TextRecognizer` contract (`lib/textRecognition.ts:24`), so the parser, form and screens don't change. Android would then have no recognition and use the manual form.

**Revisit when:** D1 fails (Task F), D3/D4 show digit "corrections" or misaligned boxes, or before production (it's on `docs/before-production.md`).

## Decision 3: web recognition via Tesseract.js 7.0.0 (provisional)
Browsers have no built-in text recognizer. On 2026-11-20 the user chose **Tesseract.js** "for now" (spec A3). Tesseract is an open-source OCR engine; Tesseract.js runs it in the browser as WebAssembly inside a Web Worker. The image never leaves the browser.

**It's provisional until the receipt eval.** Tesseract is generally weaker than Apple Vision on phone photos of receipts. If the eval shows it's not good enough on web, we replace it (or go back to manual entry on web) with a new ADR.

What we chose, and why:
- **Version:** `tesseract.js` pinned to exactly `7.0.0`, with English data from `@tesseract.js-data/eng` `1.0.0` (a dev dependency; we use its `4.0.0_best_int` model, which matches the LSTM-only engine mode).
- **Self-hosted assets, not jsDelivr.** By default Tesseract.js downloads its worker script, its WebAssembly core and its language data from the jsDelivr CDN. (Its own docs recommend the CDN.) The user chose to serve them from our own site instead:
  - **Privacy:** no third party learns who uses the scanner or when.
  - **Pinned versions:** the files come from `node_modules`, so they match `package-lock.json` exactly. A CDN URL can be changed or compromised independently.
  - **CSP:** a strict Content Security Policy later won't need to allow a CDN host.
  - **No CDN dependency:** scanning doesn't break if jsDelivr is blocked or down.
  - **Cost:** about **15 MB** added to `dist/` (three core variants plus the model), which our web host has to serve. Each user downloads only about **7 MB** on their first scan (the browser picks one core variant), and the language model is then cached in IndexedDB. Plus a small copy script to maintain.
- **How self-hosting works:** `scripts/copy-tesseract-assets.mjs` copies the worker, the three LSTM-only core builds and `eng.traineddata.gz` from `node_modules` into `public/tesseract/`. It runs automatically before `npm start`, `npm run web` and `npm run export:web` (the `prestart`, `preweb` and `preexport:web` scripts in `package.json`). `public/tesseract/` is gitignored, so nobody commits the binaries. The code points Tesseract at those same-origin paths in `tesseractPaths()` (`lib/webOcrEngine.ts:36`).
- **Lazy loading.** `tesseract.js` is loaded only when the host actually scans, via `import()` (`lib/textRecognition.web.ts:27`). Metro puts it in a separate `webOcrEngine-*` chunk, so it isn't in the bundle every visitor downloads.
- **Engine settings** (`lib/webOcrEngine.ts:20-33`): OEM 1 (LSTM neural-net engine only), `preserve_interword_spaces = 1`, and **page segmentation mode 6, not 4**.
  - The page segmentation mode (PSM) tells Tesseract what layout to expect. Tesseract's docs define 3 as "fully automatic page segmentation", 4 as "a single column of text of variable sizes", and 6 as "a single uniform block of text".
  - The spec suggested 4, because a receipt looks like one column. But on the test receipt in Task 9, modes 3 and 4 dropped every price and the Tax/Tip/Total lines: they treated the right-aligned price column as a separate region and lost it. Mode 6 read every line with its price (spec A4.1). The receipt eval re-checks this on real photos.
- **One worker per scan**, always terminated afterwards (on success, error or Cancel). This frees memory. The next scan costs only worker start-up because the model is cached.

### The jsDelivr string that is never requested (A4.2)
If you `grep cdn.jsdelivr.net dist/_expo` after a web build, you'll find one match. It's Tesseract.js's built-in **default** `workerPath`, compiled into the lazy `webOcrEngine-*` chunk. We always pass our own `workerPath`, `corePath` and `langPath`, so the default is never used. A unit test checks that the paths we pass are same-origin (`lib/textRecognition.web.test.ts:74`), and the manual browser check (criterion 60) confirms in DevTools → Network that no request goes to a third-party host. Don't "fix" the match by patching the library.

### Known limitation: a half-started worker can't be stopped (A4.3)
If the language data fails to download (offline, a 404, a CSP block), Tesseract.js never resolves or rejects the `createWorker` promise. Our code notices the failure through Tesseract's `errorHandler` and shows "Couldn't load the text reader…" (`lib/textRecognition.web.ts:86-119`). But we never get a worker object, so we **can't call `terminate()` on it**. That half-started worker sits idle until the tab is reloaded. If the promise ever does resolve later, we terminate it then (`lib/textRecognition.web.ts:106-111`). This is a limitation of the Tesseract.js API, not something we can fix from outside. It costs some memory in a tab that already failed to scan.

**Revisit when:** the receipt eval reports web accuracy; or the hosting bill for the ~15 MB matters; or Tesseract.js releases a version that settles `createWorker` on load failure.

> **Note 2026-11-25 (scan pipeline, [ADR 0018](0018-staged-scan-pipeline.md) and [ADR 0019](0019-opencv-on-web.md)):** Tesseract.js stays the web reader, still provisional. What changed around it:
> - **Where it's called from.** The scan screen no longer calls `lib/textRecognition.web.ts`. Web scans go through `scanReceipt` → the web pipeline stages → one Tesseract session per scan (`createOcrSession`, `lib/webOcrSession.ts:133`), which is reused across a retry or a second pass and terminated at the end. Lazy loading still holds (`webStagesLoader`, `lib/scanReceipt.web.ts:25`). File references above (`lib/textRecognition.web.ts:27`, `lib/webOcrEngine.ts:20-33`, `:36`) describe the code as it was on 2026-11-21; the settings now live at `TESSERACT_PARAMS` (`lib/webOcrEngine.ts:50`) and `tesseractPaths` (`:63`).
> - **A time limit.** Each read now stops after 30 s (`RECOGNIZE_TIMEOUT_MS`, `lib/webOcrSession.ts:59`; the user's choice, was 90 s).
> - **Settings measured.** Thresholding methods 0/1/2, a 300 DPI hint, `rotateAuto` and dictionaries off were each tried in the harness (spec 2026-11-22, Task 5). None helped, so PSM 6 and today's settings stay. The spec's "retry PSM 4 after the crop" check has no variant in `lib/scanPipeline/config.ts` and no Results-log row (checked 2026-11-25).
> - **First accuracy numbers.** Web line-item accuracy on 2026-11-24 was 36.4% on 3 checked tuning receipts (72.7% with the proposed crop) and 8.3% on 2 held-out receipts, against ADR 0010's 85%. Too few receipts to decide whether Tesseract stays; that decision is still open (`docs/before-production.md` §4).
> - **OpenCV may run before it** to crop the receipt, if the user turns that on (decision S-1).

## Decision 4: don't commit `ios/` or `android/` (Continuous Native Generation)
`.gitignore` lists `/ios` and `/android`. These folders are **generated** by `npx expo prebuild` (which `npx expo run:ios` runs for you) from `app.json` and the config plugins. Expo calls this **Continuous Native Generation (CNG)**.
- **For:** native settings live in one readable place (`app.json`). Upgrading the SDK means regenerating, not hand-merging Xcode project files. Config plugins (like `expo-mlkit-ocr`'s `iosEngine`) are applied the same way every time.
- **Against:** a hand edit inside `ios/` is lost the next time it's regenerated. Any native change has to be made through `app.json` or a config plugin.
- Task F's own module would live in `modules/receipt-ocr/` (committed), not in `ios/`, so it survives regeneration.

## Consequences
- The scan flow is the same on every platform: capture (`lib/capturePhoto.*`), resize (`lib/prepareImage.*`), recognize (`lib/textRecognition.*`), parse (`lib/receiptText.ts`), then the editable form. Only the capture and recognize steps differ by platform.
- `docs/before-production.md` tracks: re-checking `expo-mlkit-ocr` before launch, re-checking Tesseract after the eval, making sure the copy script runs in the production web build, and the ~15 MB of assets our host serves.
- **This ADR needs a dated update after D1** (see the status note at the top).

## Concept: platform-specific files behind one contract
SplitIt reads receipts with three different engines: Apple Vision (iOS), ML Kit (Android) and Tesseract (web). The rest of the app doesn't know which one it's using. That works because of two ideas:
- **One contract.** `lib/textRecognition.ts` defines a `TextRecognizer` type: `isAvailable()` and `recognize(uri)`, which returns lines of text with boxes. Every engine has to return that same shape, and fail with the same `RecognitionError` codes.
- **Platform file extensions.** Metro (the bundler) picks `textRecognition.native.ts` when building for iOS/Android and `textRecognition.web.ts` when building for web. So the web bundle never contains the native OCR module, and the phone app never contains Tesseract. The build checks (criteria 5 and 54) grep the bundles to prove it.

Swapping an engine later (Task F, or replacing Tesseract after the eval) means writing one new file that meets the contract. The parser, the form and their tests don't change.

## Learn more
- Expo, ImagePicker (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/
- Expo, Camera (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/camera/
- Expo, Continuous Native Generation: https://docs.expo.dev/workflow/continuous-native-generation/
- Expo, platform-specific extensions: https://docs.expo.dev/router/advanced/platform-specific-modules/
- `expo-mlkit-ocr` on npm: https://www.npmjs.com/package/expo-mlkit-ocr
- Tesseract.js, local installation (worker/core/lang paths): https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md
- Tesseract, page segmentation modes: https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html


> **Update 2026-11-21 (first real web scan):** the user uploaded a real receipt photo at `localhost:8081/scan` and reported that Tesseract.js "worked really well". Decision for now: keep Tesseract.js on web. It is still provisional until the receipt eval measures line-item accuracy on a set of real receipts.
