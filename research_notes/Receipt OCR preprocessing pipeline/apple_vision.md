# Apple Vision text recognition: input image preparation for receipt photos

Scope: what Apple Vision (`VNRecognizeTextRequest` / Swift `RecognizeTextRequest`) does internally, what Apple recommends, whether preprocessing helps, the request options, Apple's document-capture tools, and how boxes work. Context: SplitIt targets iOS 16.4+ and uses `expo-mlkit-ocr` 0.2.7 with `"iosEngine": "vision"` (in `app.json`).

Research method note: developer.apple.com doc pages are rendered with JavaScript. The machine-readable versions at `developer.apple.com/tutorials/data/documentation/...md` were fetched and quoted instead. They are the same Apple documentation.

## 1. Apple's documented request options, revisions and newer APIs

### Takeaway
SplitIt's current settings are Apple's defaults and the recommended path for offline photos: `.accurate`, language correction on, and the orientation passed in. The settings that matter for receipts and are not used yet are `minimumTextHeight` (default 1/32 of the image height, which can drop very small receipt print on a tall photo), `customWords` (only works with language correction on), pinning `revision`, `recognitionLanguages = ["en-US"]`, and reading more than one candidate per line. The Swift `RecognizeTextRequest` needs iOS 18. `RecognizeDocumentsRequest`, which returns tables, lists and paragraphs and names receipts as a use case, needs **iOS 26**. Neither can be used on SplitIt's 16.4 floor without a version check.

### Cited Findings
- **The two paths.** "Fast: ...finds individual characters, and then uses a small machine learning model to recognize individual characters and words. This approach is similar to traditional optical character recognition (OCR)." "Accurate: The accurate path uses a neural network to find text in terms of strings and lines, and then performs further analysis to find individual words and sentences." Either path can add "a language-correction phase based on Natural Language Processing (NLP)". — [Apple: Recognizing Text in Images](https://developer.apple.com/tutorials/data/documentation/vision/recognizing-text-in-images.md)
- **Accurate is the default.** "VNRecognizeTextRequest uses the accurate path by default." — [Apple: Recognizing Text in Images](https://developer.apple.com/tutorials/data/documentation/vision/recognizing-text-in-images.md)
- **WWDC19 guidance on the two paths.** For "rotated text or perspectively misaligned text, the accurate path gives you much broader support". The accurate path also gives "broader support" for stylized text. Fast is "meant for real-time reading". For processing a captured image, "you want to favor the accurate path... speed is not as important." Fast also uses less memory because "it doesn't need to run a large neural network." (The transcript is auto-generated, so wording may be slightly off.) — [WWDC19 Session 234, Text Recognition in Vision Framework](https://developer.apple.com/videos/play/wwdc2019/234/)
- **`minimumTextHeight`.** "The minimum height, relative to the image height, of the text to recognize... Increasing the size reduces memory consumption and expedites recognition with the tradeoff of ignoring text smaller than the minimum height. The default value is 1/32, or `0.03125`." Available iOS 13+. — [Apple: minimumTextHeight](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizetextrequest/minimumtextheight.md)
- **What `minimumTextHeight` does internally (WWDC19).** Text smaller than the minimum "will be ignored. It won't be processed... And the input image will be downsized, and the execution time will be smaller." The value "is expressed as a fraction of the image height." Choose capture resolution by text size: "If... you want to read the fine print of a legal document... you might actually have to increase the resolution of the camera." — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **The newer Swift name.** In the Swift `RecognizeTextRequest` the same setting is `minimumTextHeightFraction`. — [Apple: RecognizeTextRequest](https://developer.apple.com/tutorials/data/documentation/vision/recognizetextrequest.md)
- **`usesLanguageCorrection`.** "When this value is true, Vision applies language correction during the recognition process. Disabling this property returns the raw recognition results, which provides performance benefits but less accurate results." — [Apple: usesLanguageCorrection](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizetextrequest/useslanguagecorrection.md)
- **`customWords` and languages.** `customWords` is "An array of strings to supplement the recognized languages at the word-recognition stage". `recognitionLanguages` is "An array of languages to detect, in priority order". `automaticallyDetectsLanguage` attempts "detecting the language to use the appropriate model for recognition and language correction." — [Apple: VNRecognizeTextRequest](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizetextrequest.md)
- **Language bias and when custom words apply.** "If not otherwise specified, Vision biases its results toward English." "Language correction gives precedence to the custom words... The request ignores the customWords property if language correction isn't enabled." — [Apple: Recognizing Text in Images](https://developer.apple.com/tutorials/data/documentation/vision/recognizing-text-in-images.md)
- **Revisions.** `VNRecognizeTextRequestRevision1`, `Revision2` and `Revision3` exist. Revision3 is available iOS 16.0+. — [Apple: VNRecognizeTextRequestRevision3](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizetextrequestrevision3.md); [Apple: VNRecognizeTextRequest](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizetextrequest.md)
- **Apple advises pinning the revision.** "if you otherwise don't specify a revision, you will always get the latest and that might appear with some surprises." — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **Swift `RecognizeTextRequest`.** Available iOS 18.0+. It offers the same options (`recognitionLevel`, `usesLanguageCorrection`, `customWords`, `minimumTextHeightFraction`, `recognitionLanguages`, `automaticallyDetectsLanguage`). Its `perform(on:orientation:)` takes a `CGImagePropertyOrientation?` for URL, Data, CGImage, CVPixelBuffer, CMSampleBuffer or CIImage input. — [Apple: RecognizeTextRequest](https://developer.apple.com/tutorials/data/documentation/vision/recognizetextrequest.md)
- **`RecognizeDocumentsRequest`.** Available **iOS 26.0+**. "Use this request to understand different types of structured texts like receipts, nutritional labels, textbook pages, forms..." It returns a `DocumentObservation` "grouped by words, lines, or paragraphs. You can also access tables and lists". — [Apple: RecognizeDocumentsRequest](https://developer.apple.com/tutorials/data/documentation/vision/recognizedocumentsrequest.md)
- **WWDC25 on document recognition.** Previously `RecognizeTextRequest` "would return each cell of the table as a separate object"; now "the cells are automatically grouped into rows". Data detection finds "dollar amounts and their currency" (among others). There are 26 recognition languages. The session also introduces `DetectLensSmudgeRequest`, which returns a 0–1 smudge confidence, so the app can ask the user to clean the lens. — [WWDC25 Session 272, Read documents using the Vision framework](https://developer.apple.com/videos/play/wwdc2025/272/)
- **More candidates, other tips.** WWDC19 also recommends using `topCandidates(n)` ("if you want to increase the recall, you can index more candidates... at the cost of precision") and `regionOfInterest` to crop out noise and speed things up. — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)

### Inferences
- **Small print on tall receipts.** A long receipt photographed whole and upright can be about 4000 px tall. The default `minimumTextHeight` of 1/32 is then about 125 px of text height. Small receipt lines are about 1–2% of the photo height, which is below 1/32 (about 3.1%). If WWDC19's description is accurate (text below the minimum is ignored), Vision may skip fine print on long receipts at the default. Setting it lower, for example `0.01`, is worth testing on fixtures. This is an inference: Apple's doc does not say exactly what happens to text near the threshold.
- **Pin the revision.** Pinning `VNRecognizeTextRequestRevision3` (iOS 16+) keeps parser results reproducible across iOS updates. Without it, an iOS update can silently change the OCR output the eval fixtures depend on.
- **Language.** Setting `recognitionLanguages = ["en-US"]` and leaving `automaticallyDetectsLanguage` off matches US receipts and avoids detecting the wrong language. English is already the default bias.
- **iOS 26 document request.** `RecognizeDocumentsRequest` is the API most suited to receipts. It could sit behind an `if #available(iOS 26, *)` check in a custom native module. `expo-mlkit-ocr` does not offer it.

### Gaps
- Apple does not publish what changed between revisions 1, 2 and 3, or any per-revision accuracy numbers.
- The `RecognizeTextRequest.Revision` enum values for iOS 18 and later were not fetched.
- No Apple source states a maximum input image size. WWDC19 says Vision downsizes the input according to `minimumTextHeight`, but gives no pixel limits.
- `RecognizeDocumentsRequest` receipt accuracy has not been measured in any independent source found.

## 2. Does Vision preprocess internally? Does manual preprocessing help or hurt?

### Takeaway
Apple documents no internal deskew or binarization step. It says the accurate path is a neural network that handles rotated and perspective-skewed text better than the fast path, and that it resizes the input according to `minimumTextHeight`. No primary or credible benchmark was found showing that grayscale, binarization, contrast or upscaling improves Apple Vision on receipts. What Apple itself recommends is geometric: crop to the document (region of interest or document camera), correct perspective, even out the lighting, and use enough resolution for the smallest text.

### Cited Findings
- **The accurate path handles skew and stylized text.** WWDC19: "when it comes to rotated text or perspectively misaligned text, the accurate path gives you much broader support"; also "stylized text... much broader support in the accurate path." — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **Internal downsizing.** With `minimumTextHeight` set, "the input image will be downsized". — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **Apple's recommended pre-step is the Document Camera.** "what it does is already just a prospective [perspective] correction of these scans for you and it evenly lights also the image. That makes it much easier to process afterwards." — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **Region of interest.** "I use the region of interest to crop down to really what I only want to read to get rid of the noise surrounding it and enhance the performance." — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **General OCR evidence is mixed, and none of it is about Vision.** In one study of a neural OCR engine (EasyOCR), grayscale slightly lowered accuracy (71.7% to 70.75%) on license plates. — [arXiv 2410.13622](https://arxiv.org/pdf/2410.13622). For Tesseract on video text, Otsu binarization gave an "identical result" to no preprocessing. — [arXiv 1804.10687](https://arxiv.org/pdf/1804.10687)
- **Vision versus Live Text.** A developer reports `VNRecognizeTextRequest` does noticeably worse than Live Text / `ImageAnalysis` on stylized and vertical (Chinese) text. There are no replies and no Apple answer, so this is anecdotal. — [Apple Developer Forums thread 842398 (Aug 2026)](https://developer.apple.com/forums/thread/842398)

### Inferences
- **Do not binarize.** Vision's accurate recognizer is a neural network trained on natural images. Hard thresholding (binarization) throws away anti-aliasing and gray-level detail that such models use. On faded thermal receipts it can erase light strokes entirely. No evidence shows it helps Vision, and the general neural-OCR evidence points to a neutral or negative effect. Treat it as "do not do unless fixture evals show a gain."
- **Do not upscale.** Upscaling adds no information. Vision's own downsizing step (tied to `minimumTextHeight`) suggests the limit is the minimum text height setting, not pixel count. Keep the full-resolution original rather than a resized picker output.
- **Changes likely to help, ranked:**
  1. Keep full resolution: no picker `quality` or resize that shrinks the image.
  2. Crop to the receipt (document segmentation or region of interest) so the receipt fills the frame. This makes text a bigger fraction of the image height.
  3. Correct perspective.
  4. Lower `minimumTextHeight`.
  5. Only last, mild contrast or shadow evening such as `CIDocumentEnhancer`.

  All of these must be checked with the `receipt-eval` skill on saved fixtures.

### Gaps
- No controlled benchmark was found for Apple Vision with and without preprocessing on receipts (or any documents). Labeled unverified: the claim that preprocessing helps or hurts Vision specifically.
- No information was found on how Vision handles curved or crumpled paper. Apple only mentions rotation and perspective. No source was found on dewarping.

## 3. Apple's document-capture tools and whether Expo can use them

### Takeaway
`VNDocumentCameraViewController` (VisionKit, iOS 13+) is Apple's recommended capture path: it finds the page edges, corrects perspective and evens the lighting. `VNDetectDocumentSegmentationRequest` (iOS 15+) returns the four corners of the document in a photo you already have, and the Core Image `CIPerspectiveCorrection` filter can then warp it flat. `CIDocumentEnhancer` "adjusts an image's shadows and contrast". `DataScannerViewController` (iOS 16+) is a live-video scanner and is a poor fit for full receipts. None of these are exposed by `expo-mlkit-ocr`. Using any of them from Expo needs a native module (a local Expo Module in Swift, or a third-party document-scanner package) plus a development build.

### Cited Findings
- **`VNDocumentCameraViewController`.** iOS 13.0+. It "presents UI for a camera pass-through that helps people scan physical documents... The results of a scan include images, by page number." It has an `isSupported` check. — [Apple: VNDocumentCameraViewController](https://developer.apple.com/tutorials/data/documentation/visionkit/vndocumentcameraviewcontroller.md)
- **Document Camera in WWDC19.** It "finds the document, crops it out, and now I could just simply pipe it into my text recognition request"; it does perspective correction and even lighting. — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **`VNDetectDocumentSegmentationRequest`.** iOS 15.0+. "Perform this request to detect a document in an image. The result... contains the four corner points of a document's quadrilateral and saliency mask." Results are `VNRectangleObservation`. — [Apple: VNDetectDocumentSegmentationRequest](https://developer.apple.com/tutorials/data/documentation/vision/vndetectdocumentsegmentationrequest.md)
- **`CIDocumentEnhancer`.** A Core Image filter protocol with `amount` and `inputImage`. `CIFilter.documentEnhancer()` "Adjusts an image's shadows and contrast." The fetched page did not show which iOS version introduced it. — [Apple: CIDocumentEnhancer](https://developer.apple.com/tutorials/data/documentation/coreimage/cidocumentenhancer.md)
- **`DataScannerViewController`.** iOS 16.0+. It "scans the camera live video for text, data in text, and machine-readable codes". It needs `isSupported` and `isAvailable` checks and has `capturePhoto()` and `regionOfInterest`. — [Apple: DataScannerViewController](https://developer.apple.com/tutorials/data/documentation/visionkit/datascannerviewcontroller.md)
- **Smudge check (iOS 26).** `DetectLensSmudgeRequest` can flag photos taken through a smudged lens. — [WWDC25 Session 272](https://developer.apple.com/videos/play/wwdc2025/272/)
- **`expo-mlkit-ocr`'s Vision engine.** Its Vision code path exists as a "Fallback for iOS Simulator arm64-only runtimes where ML Kit cannot be linked". It is compiled when ML Kit is excluded (`EXPO_MLKIT_OCR_DISABLE_MLKIT=1`, which the `iosEngine: "vision"` plugin option presumably sets). The only native method is `recognizeText(uri)`, with no options. — local source `node_modules/expo-mlkit-ocr/ios/ExpoMlkitOcrModule.swift` and `ExpoMlkitOcr.podspec` (v0.2.7); [expo-mlkit-ocr on GitHub](https://github.com/rbayuokt/expo-mlkit-ocr); [package listing](https://www.pkgstats.com/pkg:expo-mlkit-ocr)

### Inferences
- **Lowest-effort option: a document scanner.** Wrap `VNDocumentCameraViewController` in a native module (third-party React Native document-scanner packages exist, but they were not evaluated here) and feed its output image to `recognizeText`. This gets Apple's own edge detection, perspective correction and lighting fix with no image-processing code.
- **Alternative for the existing camera flow.** Run `VNDetectDocumentSegmentationRequest`, then `CIPerspectiveCorrection` with the four corners, then optionally a mild `CIDocumentEnhancer`, then text recognition. All of it would live in one Swift module, which could also expose `minimumTextHeight`, `revision`, `recognitionLanguages` and `customWords`. Writing a small local Expo Module (forking or replacing `expo-mlkit-ocr`'s Vision path) is the only way to control these options. It is on-device only, so no backend is needed.

### Gaps
- The `CIPerspectiveCorrection` doc page and `CIDocumentEnhancer`'s iOS version were not fetched.
- No measurements were found comparing OCR accuracy on Document Camera output with raw photos.
- No Expo-compatible document-scanner package was checked for SDK 57 compatibility.

## 4. Language correction and numbers, prices and columns

### Takeaway
Apple's own WWDC19 presenters turned language correction off for codes and serial numbers, because it can "correct" `C001` into `cool`. Apple's doc says turning it off gives "raw recognition results... less accurate results". No Apple source says how correction treats prices or digits specifically. The right setting for receipts (item names need correction, prices may be hurt by it) is an empirical question for the `receipt-eval` fixtures. SplitIt currently has it ON.

### Cited Findings
- **Correction can turn codes into words.** "It helps us to get past some of the typical missed readings... but it can also get in the way. When I want to read codes or a serial number, think of the serial number like C001 that can very easily be misconstructed as cool." Correction also "does take some processing time and... memory." — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **The demo turned it off and fixed characters in code.** "I disabled the language correction because I know I'm looking for codes." The presenter then fixed typical confusions (S to 5, L to 1) in their own code using domain knowledge. — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)
- **Off means raw output.** "Disabling this property returns the raw recognition results, which provides performance benefits but less accurate results." — [Apple: usesLanguageCorrection](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizetextrequest/useslanguagecorrection.md)
- **Custom words need correction on.** `customWords` "complement the language-based correction to give you the correct transcription, even in cases where the images are more challenging". It is ignored when correction is off. — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/); [Apple: Recognizing Text in Images](https://developer.apple.com/tutorials/data/documentation/vision/recognizing-text-in-images.md)
- **Use layout and data detectors.** WWDC19 recommends using geometry: "in the case of the receipts, you can probably map the item name to the price". It also recommends data detectors for structured strings. — [WWDC19 Session 234](https://developer.apple.com/videos/play/wwdc2019/234/)

### Inferences
- **Keep correction on by default.** Receipt item names are mostly words, so correction plausibly helps them. Price tokens like `12.50` are not dictionary words, and no evidence shows Vision rewrites them. The risk is with mixed alphanumeric tokens (SKUs, `2x`, `Qty1`, abbreviations like `CHKN`).
- **A two-pass option.** Run one pass with correction on and one with it off, then take prices from the off pass and names from the on pass. This costs about 2x the time and needs a custom native module.
- **Cheaper parser-side measures.** Use `topCandidates(n>1)` for price-shaped lines, and normalize O to 0, S to 5 and l to 1 inside tokens that look like prices in `lib/receiptText.ts`, as Apple's demo did.
- **`customWords`.** Common receipt words (SUBTOTAL, GRATUITY, CHKN) could be added, but this needs a native module because `expo-mlkit-ocr` exposes no options.

### Gaps
- No primary or benchmark source shows whether Vision's language correction changes digits, decimal points or `$` signs. Labeled unverified either way.

## 5. Orientation, coordinates and word or character boxes

### Takeaway
Vision boxes are normalized from 0 to 1 with the origin at the lower left. They are relative to the processed image, which is the upright image when an orientation is passed. Apple's sample converts them with `VNImageRectForNormalizedRect` using the oriented `image.size`. With `.accurate`, `boundingBox(for:)` gives word precision, not character precision. Apple warns the boxes "aren't always an exact fit". `expo-mlkit-ocr` scales the boxes by the raw `cgImage.width/height`. For a normal portrait iPhone photo (EXIF orientation `.right`), that likely swaps the width and height scales and distorts the returned pixel boxes.

### Cited Findings
- **Coordinate convention.** "The system normalizes the coordinates to the dimensions of the processed image, with the origin at the lower-left corner of the image." — [Apple: VNDetectedObjectObservation.boundingBox](https://developer.apple.com/tutorials/data/documentation/vision/vndetectedobjectobservation/boundingbox.md)
- **Apple's conversion.** "The rectangles it provides are in normalized coordinates... convert... to image coordinates by using the VNImageRectForNormalizedRect" with `Int(image.size.width), Int(image.size.height)`, where `image` is a UIImage. — [Apple: Recognizing Text in Images](https://developer.apple.com/tutorials/data/documentation/vision/recognizing-text-in-images.md)
- **`boundingBox(for:)` precision.** "Bounding boxes aren't always an exact fit around the characters. Use them to display in user interfaces to provide general guidance, but avoid using their contents for image processing." With `.fast`, "the bounding box has character precision". With `.accurate`, "word precision... the bounding box of the whole word containing the first character." — [Apple: boundingBox(for:)](https://developer.apple.com/tutorials/data/documentation/vision/vnrecognizedtext/boundingbox(for:).md)
- **How the accurate path splits words.** "The accurate path tokenizes on whitespace". — [Apple: Recognizing Text in Images](https://developer.apple.com/tutorials/data/documentation/vision/recognizing-text-in-images.md)
- **Developer reports of box problems.** Developers report `boundingBox(for:)` returning wrong or identical boxes for different ranges with `.accurate`. These are forum reports, not confirmed by Apple. — [Apple Developer Forums 705477](https://developer.apple.com/forums/thread/705477); [Apple Developer Forums 131510](https://developer.apple.com/forums/thread/131510)
- **Orientation input.** The Swift API takes the orientation directly through `perform(on:orientation:)`. — [Apple: RecognizeTextRequest](https://developer.apple.com/tutorials/data/documentation/vision/recognizetextrequest.md)
- **What `expo-mlkit-ocr` does.** It maps `UIImage.imageOrientation` to `CGImagePropertyOrientation` and passes it to `VNImageRequestHandler(cgImage:orientation:)`. It then calls `denormalizeVisionRect(rect, imageSize: CGSize(width: cgImage.width, height: cgImage.height))`, flipping y to a top-left origin. It sorts observations by `minY` descending, then `minX`. Word boxes come from `top.boundingBox(for: range)` for each whitespace-split word, falling back to the line box. It uses `topCandidates(1)` only. — local source `node_modules/expo-mlkit-ocr/ios/ExpoMlkitOcrModule.swift` (v0.2.7)

### Inferences
- **Likely bug: boxes scaled by the wrong dimensions.** Apple normalizes to the processed (oriented) image and its sample scales by `UIImage.size` (oriented). `expo-mlkit-ocr` instead uses `cgImage.width/height`, the raw sensor pixels, which are landscape for a portrait iPhone photo tagged `.right`. The pixel boxes would then be stretched: x scaled by the long side, y by the short side. Relative order within each axis is kept, so top-to-bottom line grouping still works. But any parser logic that compares x with y, uses absolute pixel thresholds, or measures aspect ratio would be wrong.
  - Unverified: it depends on whether the picker output still carries EXIF orientation. If expo-image-picker writes an already-rotated `.up` JPEG, the problem disappears.
  - Check: log `image.imageOrientation` and the box ranges on device.
- **Sorting is effectively by y only.** The exact-equality `minY` comparison means the order is effectively by y alone. On a slightly tilted receipt, the price on the right of a row can sort before or after the name. Line grouping in `lib/receiptText.ts` should use y-overlap tolerance, not this order.
- **Word boxes are approximate.** With `.accurate`, word boxes are word-precise at best and may be approximate. They are good enough for column assignment (name on the left, price on the right), but not for cropping characters.

### Gaps
- No Apple source explicitly confirms that `boundingBox` is in the oriented coordinate space when an orientation is passed. "Processed image" plus Apple's `UIImage.size` sample strongly implies it. Not tested on device.
- Whether `expo-image-picker` output on SDK 57 keeps a non-`.up` EXIF orientation was not checked.
