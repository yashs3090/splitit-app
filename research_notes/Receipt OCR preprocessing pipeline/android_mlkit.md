# Android: preparing input images for ML Kit Text Recognition v2 (receipts)

Note: Some findings come from reading the installed package at `node_modules/expo-mlkit-ocr` (v0.2.7) in this repo. Those are marked "[local source]" and give the file path instead of a URL.

## 1. Google's input image guidelines for ML Kit text recognition

### Takeaway
Google gives one concrete pixel target: each character should ideally be at least 16x16 px, and going above about 24x24 px brings no accuracy gain. The rest of the guidance is qualitative: get good focus, make the text fill as much of the frame as possible, and pass the correct rotation. Google publishes no "recommended megapixels for documents" and no image size cap.

### Cited Findings
- "Ideally, each character should be at least 16x16 pixels." "There is generally no accuracy benefit for characters to be larger than 24x24 pixels." — [ML Kit Text Recognition v2, Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- The only resolution example: "a 640x480 image might work well to scan a business card that occupies the full width of the image." — [same page](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- "Poor image focus can affect text recognition accuracy." The older Firebase/v1 doc adds "If you aren't getting acceptable results, try asking the user to recapture the image." — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android); [Firebase ML Kit v1 doc](https://firebase.google.com/docs/ml-kit/android/recognize-text)
- Latency: "To reduce latency, ensure that the text occupies as much of the image as possible." — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- Ways to build an `InputImage`: "from either a Bitmap, media.Image, ByteBuffer, byte array, or a file on the device." For `media.Image` you pass the rotation; CameraX will "calculate the rotation value for you"; otherwise "calculate it from the device's rotation degree and the orientation of camera sensor." — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- `fromBitmap`, `fromMediaImage`, `fromByteArray` and `fromByteBuffer` take `rotationDegrees`. The value is counter-clockwise, and "Only 0, 90, 180, 270 are supported" (any other value throws `IllegalArgumentException`). `fromMediaImage` supports only JPEG and YUV_420_888 ("YUV_420_888 is more efficient for all our APIs"). Byte arrays and buffers support NV21 and YV12. — [InputImage API reference](https://developers.google.com/android/reference/com/google/mlkit/vision/common/InputImage)
- `fromFilePath(Context, Uri)` is documented only as "Creates an InputImage from a local image file Uri". The reference says nothing about EXIF orientation, downscaling or size limits. — [InputImage API reference](https://developers.google.com/android/reference/com/google/mlkit/vision/common/InputImage)
- `expo-mlkit-ocr` (v0.2.7) on Android calls `InputImage.fromFilePath(context, Uri.parse(uri))` and then `TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)`. Our only input knob is therefore the file at the URI we pass. There is no rotation parameter, no bitmap path and no ROI. — [local source] `node_modules/expo-mlkit-ocr/android/src/main/java/expo/modules/mlkitocr/ExpoMlkitOcrModule.kt`

### Inferences
- Applying the 16–24 px/char rule to a receipt: a typical 80 mm thermal receipt has about 42–48 characters per line. If the receipt fills the frame width, roughly 48 chars × 24 px ≈ 1150 px of width is the useful ceiling, and about 770 px (16 px/char) is the floor. A 12 MP photo (about 3000–4000 px wide) of a receipt filling the frame is far above the ceiling. Downscaling the long side to about 2000–2500 px should cost no accuracy and saves memory and latency. (These figures are my arithmetic from Google's rule; they are not a Google recommendation.) Long receipts photographed whole are the risk case. If the receipt fills only half the frame width, or the photo is taken from far away to fit its length, characters can drop below 16 px. The practical guidance: keep the receipt filling the frame width, and use multiple captures or a scanner flow for long receipts.
- Because `fromFilePath` doesn't document EXIF handling, we should not rely on it. The safest approach is to bake orientation into the pixels before OCR, for example by re-encoding through `expo-image-manipulator`, which writes an upright JPEG. ML Kit v2's Latin model has had "all-orientation support" since 2022–23 (see §2), so a wrong orientation may still read, but this is unverified for receipts.

### Gaps
- No Google source gives a maximum input size, or says whether ML Kit downsamples large inputs internally.
- I found no source confirming whether `fromFilePath` applies EXIF rotation. It needs a device test: OCR a portrait photo whose EXIF orientation is 90 and check whether the text comes back correctly.

## 2. v2 vs v1, bundled vs unbundled, scripts and output structure

### Takeaway
`expo-mlkit-ocr` uses the bundled Latin v2 model (`com.google.mlkit:text-recognition:16.0.1`). That model gives a per-element confidence, an angle, corner points and symbols. However, the Expo module currently passes only the text and axis-aligned bounding boxes for blocks, lines and elements to JavaScript. Confidence, angle, corner points and symbols are dropped.

### Cited Findings
- Bundled vs unbundled. Unbundled: "Model is dynamically downloaded via Google Play Services", "About 260 KB size increase per script architecture", and you "Might have to wait for model to download before first use." Bundled: "statically linked to your app at build time", "About 4 MB size increase per script per architecture", and the model "is available immediately." — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- Supported scripts: Latin, Chinese, Devanagari, Japanese and Korean, each with its own library and options class. — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- Output hierarchy: a `Text` object holds the full text and its `TextBlock`s; blocks hold Lines, Lines hold Elements ("a word or a word-like entity"), and Elements hold Symbols ("a character, a digit or a word-like entity"). Each level carries bounding coordinates, "rotation information, confidence score etc." — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- `Text.Element` API:
  - `getAngle()` returns "degrees, clockwise is positive, range is [-180, 180]".
  - `getConfidence()` is in the range [0.0, 1.0]. It "will be unavailable (i.e. returns 0) if you're using the unbundled version … with an older version of Google Play services (lower than 22.30.XX)".
  - `getCornerPoints()` returns "four corner points in clockwise direction starting with top-left. Due to the possible perspective distortions, this is not necessarily a rectangle".
  - `getSymbols()`: "not available for unbundled versions of Text Recognition library yet".
  - `getRecognizedLanguage()` returns a BCP47 code.
  - Source: [Text.Element reference](https://developers.google.com/android/reference/com/google/mlkit/vision/text/Text.Element)
- History from the release notes:
  - Apr 26 2022: bundled v2 models upgraded, "added all-orientation support for Latin".
  - Aug 16 2022: "exposed confidence score for Text Recognition".
  - Sep 20 2022: v2 started "providing symbol and rotation information".
  - May 2 2023: bundled v2 reached General Availability; unbundled Latin was upgraded with all-orientation support.
  - Aug 7 2024: `text-recognition` 16.0.1 and `play-services-mlkit-text-recognition` 19.0.1 released, with 16 KB page-size support.
  - Oct 26 2026: the Play-services v2 SDKs were rebuilt (19.0.2), with no API changes.
  - Source: [ML Kit release notes](https://developers.google.com/ml-kit/release-notes)
- v1 is the old Firebase ML Kit text recognition (the same 16x16 guidance appears there). v2 is the current standalone ML Kit SDK. — [Firebase ML Kit v1](https://firebase.google.com/docs/ml-kit/android/recognize-text)
- `expo-mlkit-ocr` depends on `com.google.mlkit:text-recognition:16.0.1` (bundled Latin). Its JS types expose `text` plus `boundingBox {x,y,width,height}` for blocks, lines and elements only. — [local source] `node_modules/expo-mlkit-ocr/android/build.gradle`, `node_modules/expo-mlkit-ocr/build/ExpoMlkitOcr.types.d.ts`
- The package is small and community-maintained: one maintainer, about 136 weekly downloads. — [Socket.dev](https://socket.dev/npm/package/expo-mlkit-ocr) (third-party mirror; check the [GitHub repo](https://github.com/rbayuokt/expo-mlkit-ocr))

### Inferences
- Bundled Latin adds about 4 MB per ABI to the Android binary, but it works offline on first launch and has full confidence and symbol support. That suits our use case.
- If the parser needs confidence (for example, to flag doubtful prices) or the line angle (for de-skewed row grouping), we would have to patch or fork `expo-mlkit-ocr`, or write a small local Expo module, to also return `getConfidence()`, `getAngle()` and `getCornerPoints()`. The change is small, because the Kotlin mapper already walks every element.
- Axis-aligned boxes on a skewed photo will overlap between rows. That matters if `lib/receiptText.ts` groups columns by y-coordinate.

### Gaps
- Google publishes no accuracy figures comparing v1 and v2, or bundled and unbundled.

## 3. Does ML Kit handle skew, rotation, perspective and low contrast internally? Does preprocessing help?

### Takeaway
Google doesn't document ML Kit's internal preprocessing. The only indirect evidence is "all-orientation support" for Latin and non-rectangular corner points "due to possible perspective distortions". I found no ML Kit-specific benchmark showing that grayscale, binarization, contrast changes or upscaling help or hurt. General OCR literature finds the effect depends on the engine and is often negligible or slightly negative for modern neural recognizers. Treat any preprocessing as an A/B experiment on our own fixtures.

### Cited Findings
- All-orientation support for Latin (bundled 2022, unbundled 2023). — [ML Kit release notes](https://developers.google.com/ml-kit/release-notes)
- Corner points are "not necessarily a rectangle" "due to the possible perspective distortions", and each element reports a rotation angle. This implies the detector localizes rotated and perspective-skewed text. — [Text.Element reference](https://developers.google.com/android/reference/com/google/mlkit/vision/text/Text.Element)
- Google's stated levers are resolution, focus and how much of the frame the text fills, not image filters. — [v2 Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- A license-plate study found grayscale slightly lowered EasyOCR accuracy (71.7% to 70.75%). This is a neural OCR engine, not ML Kit. — [arXiv 2410.13622](https://arxiv.org/pdf/2410.13622)
- A Tesseract study found the gain from the best preprocessing was "negligible". It also argues a preprocessor must be tuned to the specific engine. — [arXiv 2105.07983](https://arxiv.org/pdf/2105.07983)
- A developer write-up on ML Kit with receipts: a low-resolution receipt scan returned only two blocks for the whole image; the author concluded that decent resolution is required. — [TSH blog](https://tsh.io/blog/simple-ocr-implementation-on-android-with-googles-ml-kit)
- Google's cloud OCR (Document AI) handles deskew and rotation correction server-side, which shows Google's large models expect to do this themselves. — [Document AI Enterprise OCR](https://docs.cloud.google.com/document-ai/docs/ocr-add-ons)

### Inferences
- Likely net positive:
  - downscale oversized photos to about 2000–2500 px on the long side (§1)
  - bake in EXIF orientation
  - crop to the receipt, which raises px/char for a fixed input size and cuts latency, per Google's "occupies as much of the image as possible"
  - perspective correction, via the Document Scanner below
- Likely neutral or risky: global binarization. Thermal receipts often have faded print and uneven lighting, so a fixed threshold can erase thin strokes. Grayscale is probably harmless but unproven to help. Upscaling only makes sense if characters fall below 16 px.
- The confidence scores from §2, once exposed, could drive a "retake photo" prompt, in line with Google's advice to ask users to recapture blurry images.

### Gaps
- I found no Google statement on whether ML Kit normalizes contrast or illumination internally.
- I found no published numeric benchmark of preprocessing on ML Kit v2 accuracy. Our own `receipt-eval` fixtures are the only way to get one.
- I couldn't search the googlesamples/mlkit GitHub issues directly (the `gh` CLI isn't available), so community reports there are unchecked.

## 4. Android document capture: ML Kit Document Scanner API

### Takeaway
`GmsDocumentScanning` is a full-screen scanning flow delivered by Google Play services. It handles auto-capture, edge detection and cropping, auto-rotation, filters, shadow removal and ML stain/finger removal, and returns JPEG and/or PDF. It needs no camera permission and adds about 300 KB. It is Android-only (iOS would use VisionKit) and needs a dev build. Expo-compatible wrappers already exist. It produces a flattened, tightly cropped, upright image, which is exactly what §1 asks for. Google publishes no OCR-accuracy figures for its output.

### Cited Findings
- Features: automatic capture with document detection, "accurate edge detection" for cropping, automatic rotation detection, and editing tools for cropping, filters, shadow removal and stain cleaning. The whole flow runs on-device. No camera permission is required from the host app. — [Document Scanner overview](https://developers.google.com/ml-kit/vision/doc-scanner)
- Modes:
  - `SCANNER_MODE_BASE`: crop, rotate and reorder pages.
  - `SCANNER_MODE_BASE_WITH_FILTER`: adds filters such as grayscale and auto-enhance.
  - `SCANNER_MODE_FULL` (the default): adds ML cleaning such as erasing stains and fingers, and is the only mode that gets new major features via Play services.
  - Source: [Document Scanner overview](https://developers.google.com/ml-kit/vision/doc-scanner)
- Requirements: "Android API level 21 or above" and "a minimal device total RAM of 1.7GB". Below that it throws `MlKitException` with code `UNSUPPORTED`. The download size increase is about 300 KB. "Users might have to wait for the models, logic and UI flow to download before first use." — [Document Scanner Android](https://developers.google.com/ml-kit/vision/doc-scanner/android). One third-party summary says minSdk 24; that conflicts with Google's "21" ([search result summary](https://github.com/dariyd/react-native-document-scanner), unverified).
- Output: `GmsDocumentScanningResult` gives the page count, JPEG page URIs and a PDF URI. You can request only the formats you need, because generation costs time. There are options for `setPageLimit` and `setGalleryImportAllowed`. — [Document Scanner Android](https://developers.google.com/ml-kit/vision/doc-scanner/android)
- Status: Beta from Feb 20 2024 (16.0.0-beta1); General Availability from Sep 29 2025 (`play-services-mlkit-document-scanner` 16.0.0). — [ML Kit release notes](https://developers.google.com/ml-kit/release-notes)
- React Native / Expo wrappers:
  - `@infinitered/react-native-mlkit-document-scanner`: Android only, because "ML Kit does not provide a Document Scanning module for iOS". It exposes `launchDocumentScannerAsync({ pageLimit, galleryImportAllowed, resultFormats })`. — [Infinite Red docs](https://docs.infinite.red/react-native-mlkit/document-scanner)
  - `react-native-document-scanner-plugin` wraps ML Kit on Android and VisionKit on iOS, and needs Expo dev builds (not Expo Go). — [GitHub](https://github.com/websitebeaver/react-native-document-scanner-plugin); [Scanbot write-up on Expo use](https://scanbot.io/techblog/how-to-use-react-native-document-scanner-plugin-with-expo/)
  - `@dariyd/react-native-document-scanner` and `expo-document-scanner` (a Nitro module) are other cross-platform options. — [dariyd GitHub](https://github.com/dariyd/react-native-document-scanner); [pkgstats](https://www.pkgstats.com/pkg:expo-document-scanner) (not inspected in depth)

### Inferences
- Pipeline option for Android: Document Scanner (`pageLimit` 1, JPEG only, mode FULL or BASE_WITH_FILTER), then the JPEG URI, then `expo-mlkit-ocr.recognizeText(uri)`. This skips custom crop and perspective code entirely. A cross-platform plugin (websitebeaver or dariyd) would give the same flow on iOS through VisionKit. That fits the existing dev-build requirement, and the plugins ship config plugins and autolinking. It needs no backend, so it fits ADR 0010.
- The scanner's ML "auto enhance" and shadow removal are tuned for readability and not proven to help OCR. Our fixtures should compare the scanner's FULL output, its BASE (crop-only) output and the raw photo.
- Devices without Play services (some Huawei, some Chinese ROMs) or with under 1.7 GB of RAM need a fallback to the plain camera or image picker path.
- Long receipts: `pageLimit` above 1 lets the user capture a long receipt in pieces. The parser would then need to merge the pages and de-duplicate overlapping lines.

### Gaps
- Google publishes no measurement of OCR accuracy on Document Scanner output compared with raw photos.
- I didn't confirm the output JPEG resolution or compression, or whether the scanner's filters are applied to the returned JPEG by default.

## 5. Google guidance for receipts specifically (Document AI as reference)

### Takeaway
Google's cloud document stack asks for at least 200 dpi, with 300 dpi or more best. It does its own deskew and rotation correction and can return image-quality scores (blur, glare, text too small and so on). There is no receipt-specific preprocessing guidance. This supports focusing on resolution, framing, focus and glare checks over pixel filters.

### Cited Findings
- Minimum 200 dpi; 300 dpi or higher generally best. "Reducing file sizes for lossy formats may result in a degradation of image quality." — [Document AI supported files](https://docs.cloud.google.com/document-ai/docs/file-types)
- Enterprise Document OCR can return page-level image-quality scores (0–1) across eight dimensions, including blurry, noisy, dark, faint, text too small, glare and cutoff. When the score is below 0.5 it lists the defect reasons. It also supports deskew and rotation correction. — [Enterprise Document OCR](https://docs.cloud.google.com/document-ai/docs/ocr-add-ons)

### Inferences
- For an 80 mm (about 3.15 in) wide receipt, 300 dpi works out to about 945 px across the receipt width. That roughly agrees with the ML Kit 16–24 px/char range from §1 (my arithmetic).
- Document AI's defect categories (blur, glare, too-small text, cutoff) are a good checklist for on-device "retake" heuristics.

### Gaps
- I didn't fetch the Document AI receipt/expense parser pages. I found no receipt-specific image preprocessing guidance from Google.
