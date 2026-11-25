# Implementation options for receipt OCR image preprocessing (browser + Expo SDK 57 / RN 0.86)

Research date: 2026-11-22. npm data comes from the live registry (`registry.npmjs.org/<pkg>`) on that date. "Unpacked" is the npm tarball's unpacked size, not the size your app ships. Anything marked **(unverified)** comes from background knowledge and has no fetched source.

## Browser: opencv.js vs hand-written Canvas/typed-array pipeline vs other libs (sizes, load, speed, lazy loading)

### Takeaway
Official opencv.js is a single ~10.5 MB JS file (4.13.0), and the `@techstark/opencv-js` npm build is ~13.3 MB. Both are heavy next to a Tesseract.js worker. For a receipt pipeline of grayscale, contrast stretch, Otsu/Sauvola threshold and an upscale, a few hundred lines of hand-written typed-array code are enough, and they can run in a Web Worker with OffscreenCanvas. opencv.js (or jscanify, which wraps it) is only worth lazy-loading if automatic document-corner detection and perspective warp are needed on web.

### Cited Findings
- Official opencv.js: `https://docs.opencv.org/4.x/opencv.js` redirects to `4.13.0/opencv.js`, which has `content-length: 10964323` bytes (~10.5 MiB, uncompressed over the wire as measured by HEAD) — [docs.opencv.org/4.13.0/opencv.js](https://docs.opencv.org/4.13.0/opencv.js)
- `@techstark/opencv-js`: latest `5.0.0-release.1`, published 2026-06-24, Apache-2.0, main file `dist/opencv.js` is 13,298,869 bytes, 234 files, 14.7 MB unpacked — [npm registry](https://registry.npmjs.org/@techstark/opencv-js), [jsDelivr file listing](https://data.jsdelivr.com/v1/packages/npm/@techstark/opencv-js@5.0.0-release.1)
- `jscanify` 1.4.3 (published 2026-07-20, MIT) is "The Javascript document scanning library". It does paper detection/highlighting and "paper scanning with distortion correction" (`highlightPaper`, `extractPaper(image, w, h)`). It is "powered by opencv.js" and its CDN example loads `docs.opencv.org/4.7.0/opencv.js` asynchronously because OpenCV "can take a while to load". Detection works best on a flat surface with a uniform background. v1.3.0+ added glare suppression — [GitHub puffinsoft/jscanify](https://github.com/puffinsoft/jscanify)
- jscanify's npm `main` is `src/jscanify-node.js` with dependencies `jsdom ^29.1.1` and `canvas ^3.2.3` (Node-side). Unpacked size is 30.4 MB, and it does not bundle OpenCV in the browser path — [npm registry](https://registry.npmjs.org/jscanify)
- `image-js` 1.7.1 (published 2026-09-30, MIT, 11.7 MB unpacked) is a pure-JS image processing library — [npm registry](https://registry.npmjs.org/image-js)
- Tesseract.js itself accepts `img`/`canvas` elements, `File`/`Blob`, base64 strings or buffers of an encoded image (bmp/jpg/png/pbm/webp/gif). "A buffer containing raw pixel data is not supported", so a preprocessing pipeline must hand back a canvas or an encoded blob — [tesseract.js docs/image-format.md](https://github.com/naptha/tesseract.js/blob/master/docs/image-format.md)

### Inferences
- Size comparison: opencv.js (~10.5–13 MB) is several times the size of Tesseract.js 7's JS package (1.4 MB unpacked, [npm](https://registry.npmjs.org/tesseract.js)), not counting Tesseract's core wasm and eng traineddata. Even lazy-loaded, it would add a large download on mobile data the first time a host scans on web.
- Recommended web shape: one `preprocess.ts` module in `lib/` (pure functions on `Uint8ClampedArray` plus width/height, so they can be unit-tested in Jest without a DOM). Steps: luminance grayscale → histogram percentile contrast stretch → Otsu (global) or Sauvola via integral images (local) → optional 2x upscale when text is small. Load it with the same dynamic `import()` lazy chunk as Tesseract. Integral-image Sauvola is O(n) per pixel, and a ~2000×3000 receipt is 6 M pixels, so a few passes over typed arrays should take on the order of 100s of ms on a phone **(unverified, no benchmark found)**.
- Running in a Web Worker with `OffscreenCanvas` keeps the UI responsive. Tesseract.js already runs in its own worker, so preprocessing can either share that pattern or run on the main thread before `recognize()`.
- Keep opencv.js / jscanify as an optional later chunk, only if web users need auto-crop of photos taken at an angle. Expect the host to wait several seconds on first load.

### Gaps
- Could not fetch the OpenCV.js build tutorial (docs.opencv.org returned 403 to the fetcher). Not verified: the exact flags for `--build_wasm`, `--simd`, `--threads` and custom module whitelists (`opencv_js.config.py`), and the size of a minimal imgproc-only build. From background knowledge **(unverified)**: the build script supports `--build_wasm`, `--simd`, `--threads` and a `--config` whitelist file, and an imgproc-only build is a few MB.
- Not checked: whether the official 4.13.0 file embeds the wasm (single-file) or how much gzip/brotli shrinks it. Content-length was measured without `Accept-Encoding`.
- No published benchmark found for Canvas/typed-array Sauvola/CLAHE or opencv.js timings on ~2000 px images in a mobile browser. Measure on device.
- WebGL/WebGPU shader approaches were not researched in depth (out of tool budget). They are likely overkill for one still image.

## Does Tesseract.js (v5–v7) offer preprocessing hooks?

### Takeaway
Yes, but only a little. Tesseract.js 7 has `rotateAuto` (deskew from detected line angle), `rotateRadians`, `rectangle` (OCR a region), and non-recognition outputs `imageColor`, `imageGrey` and `imageBinary` that return Tesseract's own internal grey/binarized image, which is useful for debugging what Tesseract "sees". OSD (`worker.detect`) needs the legacy model, which is off by default since v5. Tesseract does its own binarization internally, so contrast and resolution are what an external pipeline mainly adds.

### Cited Findings
- Source of tesseract.js master (package version 7.0.0, depends on `tesseract.js-core ^7.0.0`). Tesseract.js-only recognize options are `['rectangle', 'pdfTitle', 'pdfTextOnly', 'rotateAuto', 'rotateRadians']`. Outputs that do not need recognition are `['imageColor', 'imageGrey', 'imageBinary', 'layoutBlocks', 'debug']`, and if only those are requested, recognition is skipped — [src/worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js)
- How `rotateAuto` works: it temporarily switches to PSM AUTO if needed, calls `FindLines()`, then `GetGradient()`/`GetAngle()`. Angles under 0.005 rad (~0.3°) are ignored, otherwise it calls `setImage` again with that rotation. The result includes `rotateRadians` — [src/worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js)
- v5.0.5 fixed "`rotateAuto` option unnecessarily inflating runtime". In v5, "`worker.detect` function disabled by default", and OSD needs `legacyCore: true, legacyLang: true`. v5 cut English language file size by 54% and worker memory from 311 MB to 164 MB — [tesseract.js releases](https://github.com/naptha/tesseract.js/releases)
- v6: "All outputs formats other than `text` are now disabled by default". Enable them per call, e.g. `{ hocr: true }` (the same applies to `imageBinary: true`), as the third argument to `recognize`. v6 also fixed memory growing until a crash — [tesseract.js releases](https://github.com/naptha/tesseract.js/releases)
- v7.0.0 (Dec 2025): "Significant improvements to recognition speed", a new `relaxedsimd` build, and runtimes ~15–35% lower than v6; dropped Node 14 — [tesseract.js releases](https://github.com/naptha/tesseract.js/releases); npm `tesseract.js` 7.0.0 published 2025-12-15, Apache-2.0 — [npm](https://registry.npmjs.org/tesseract.js)
- `setParameters` supports `tessedit_pageseg_mode`, `tessedit_char_whitelist`, `preserve_interword_spaces`, and `user_defined_dpi` ("use to fix Warning: Invalid resolution 0 dpi. Using 70 instead.") — [docs/api.md](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)

### Inferences
- `rotateAuto: true` is a free deskew for small tilts (it measures the line gradient). It does not handle 90°/180° rotation (that needs OSD/legacy) or perspective distortion.
- Requesting `{ imageBinary: true }` in dev builds and showing the result is a cheap way to see whether external preprocessing helps or hurts Tesseract's built-in thresholding.
- Setting `user_defined_dpi` (e.g. 300) for camera images, which carry no DPI, avoids the 70 dpi fallback warning. Its effect on accuracy should be measured with the receipt-eval fixtures.

### Gaps
- Not verified from Tesseract docs in this pass: the Tesseract 5 `thresholding_method` parameter (Otsu / LeptonicaAdaptiveNormalize / Sauvola), or whether tesseract.js-core 7 exposes it via `setParameters`. From background knowledge **(unverified)**: Tesseract 5.x added `thresholding_method` with 0 = legacy Otsu, 1 = adaptive normalize + Otsu, 2 = Sauvola. If tesseract.js-core 7 exposes it, it could replace hand-written thresholding on web.

## Expo / React Native options: capabilities, SDK 57 / New Architecture compatibility, dev-build needs, maintenance, license, size

### Takeaway
`expo-image-manipulator` only does geometry (resize/rotate/flip/crop, plus `extent` on web) and encoding, with no pixel filters. For pixel work on device the realistic options are `@shopify/react-native-skia` (color matrix, shaders and offscreen surfaces for grayscale, contrast and threshold; MIT; big native binary) and `react-native-fast-opencv` (JSI OpenCV with cvtColor, adaptiveThreshold, GaussianBlur, findContours and warpPerspective; MIT; New Architecture only since v1; no CLAHE in its function list). The OS document scanner via `react-native-document-scanner-plugin` gives auto-crop, perspective correction and cleanup with almost no code. Every option except image-manipulator needs a development build.

### Cited Findings
**expo-image-manipulator**
- Operations: `resize`, `rotate`, `flip`, `crop`. `extent` is web-only. Save formats are JPEG/PNG/WEBP, with `compress` 0–1 and `base64`. API is `useImageManipulator` / `ImageManipulator.manipulate(...)` → chainable context → `renderAsync()` → `ImageRef.saveAsync()`. `manipulateAsync` is deprecated. No filters (grayscale/contrast) are documented. Works on Android, iOS, tvOS and Web, and is "Included in Expo Go" — [docs.expo.dev imagemanipulator (latest)](https://docs.expo.dev/versions/latest/sdk/imagemanipulator/)
- npm latest is 58.0.16 (2026-10-28, MIT). That is the SDK 58 line, so SDK 57 apps should use the version `npx expo install` pins — [npm](https://registry.npmjs.org/expo-image-manipulator)

**react-native-document-scanner-plugin**
- 2.0.4, published 2026-01-02, MIT, 54 KB unpacked, peer deps `react`/`react-native` `*` — [npm](https://registry.npmjs.org/react-native-document-scanner-plugin)
- Android depends on `com.google.android.gms:play-services-mlkit-document-scanner:16.0.0`, i.e. the ML Kit Document Scanner, delivered via Google Play services. `package.json` has a `codegenConfig` (`DocumentScannerSpec`, type `modules`), meaning it is set up as a TurboModule for the New Architecture — [android/build.gradle](https://github.com/websitebeaver/react-native-document-scanner-plugin/blob/master/android/build.gradle), [package.json](https://github.com/websitebeaver/react-native-document-scanner-plugin/blob/master/package.json)
- Expo: add `react-native-document-scanner-plugin` to `plugins` in app.json, then prebuild/EAS build. It does not run in Expo Go. Options: `croppedImageQuality` (0–100), `maxNumDocuments` (Android only), `responseType` (`base64` or `imageFilePath`). Returns `scannedImages[]` and `status`. iOS needs `NSCameraUsageDescription`. On Android, if another plugin adds the CAMERA permission without requesting it, you get a "Permission Denial: starting Intent" error — [README](https://github.com/websitebeaver/react-native-document-scanner-plugin)
- Repo: 469 stars, 52 open issues, last push 2026-01-02 — [GitHub API](https://api.github.com/repos/websitebeaver/react-native-document-scanner-plugin)
- Alternative: `@dariyd/react-native-document-scanner` 2.2.0 (2026-10-27, MIT, peer `react-native >=0.77.3`) — [npm](https://registry.npmjs.org/@dariyd/react-native-document-scanner) (README not reviewed)

**react-native-fast-opencv**
- 1.0.1, published 2026-08-03, MIT, 583 KB unpacked — [npm](https://registry.npmjs.org/react-native-fast-opencv)
- Exposes OpenCV's C++ API to JS through JSI. "V1 supports only the new architecture", tested on RN 0.85+. Works with VisionCamera frame processors and react-native-worklets-core, so heavy calls can run off the JS thread. 259 stars, 2 open issues — [GitHub README](https://github.com/lukaszkurantdev/react-native-fast-opencv)
- Links prebuilt OpenCV: iOS **4.9.0** (`FastOpenCV-iOS` pod, opencv2.xcframework) and Android **4.12.0** (`org.opencv:opencv:4.12.0` from Maven Central). The README warns that behaviour may differ slightly between platforms — [docs/installation.md](https://github.com/lukaszkurantdev/react-native-fast-opencv/blob/main/docs/content/installation.md)
- The available-functions doc includes `cvtColor`, `threshold`, `adaptiveThreshold`, `GaussianBlur`, `medianBlur`, `bilateralFilter`, `morphologyEx`, `findContours`, `approxPolyDP`, `minAreaRect`, `getPerspectiveTransform`, `warpPerspective` and `resize`. `createCLAHE`/`equalizeHist` do not appear. Custom C++ functions can be added — [docs/availablefunctions.md](https://github.com/lukaszkurantdev/react-native-fast-opencv/blob/main/docs/content/availablefunctions.md), [docs/customized.md](https://github.com/lukaszkurantdev/react-native-fast-opencv/blob/main/docs/content/customized.md)
- Android default ABIs are `armeabi-v7a, x86, x86_64, arm64-v8a`, and it packages `libopencv_java4.so` from the OpenCV AAR — [android/build.gradle](https://github.com/lukaszkurantdev/react-native-fast-opencv/blob/main/android/build.gradle)

**react-native-opencv3**
- 1.0.8, last published 2020-07-27, peer `react-native 0.59.5`, 155 MB unpacked: abandoned and unsuitable for RN 0.86 — [npm](https://registry.npmjs.org/react-native-opencv3)

**@shopify/react-native-skia**
- 2.14.0, published 2026-10-01, MIT, 10.1 MB unpacked. Peers: `react >=19`, `react-native >=0.78`, `react-native-reanimated >=4`, `react-native-worklets >=0.7`. Native binaries come from separate packages (`react-native-skia-android`/`-apple-ios` 154.0.0), and the web build uses `canvaskit-wasm` 0.41.0 — [npm](https://registry.npmjs.org/@shopify/react-native-skia). The repo now resolves to `wcandillon/react-native-skia` on GitHub — [GitHub API redirect](https://api.github.com/repos/Shopify/react-native-skia)
- Has offscreen surfaces (`makeOffscreenSurface` / `drawOffscreen`), `makeImageSnapshot` and `encodeToBase64(ImageFormat.PNG, 100)` / `encodeToBytes`. `Skia.ColorFilter.MakeMatrix` takes a 20-value matrix, with a documented grayscale example (0.21/0.72/0.07). There is a `ColorMatrix` component — [Skia color filters docs](https://shopify.github.io/react-native-skia/docs/color-filters), [Mintlify mirror: offscreen](https://www.mintlify.com/shopify/react-native-skia/canvas/offscreen), [Mintlify mirror: snapshot](https://www.mintlify.com/shopify/react-native-skia/advanced/snapshot)

**react-native-vision-camera**
- 5.2.4, published 2026-10-29, MIT. v5 peers on `react-native-nitro-modules` and `react-native-nitro-image` (Nitro-based) — [npm](https://registry.npmjs.org/react-native-vision-camera)

### Inferences
- Skia is the lightest option for pixel filters on native, since it needs no OpenCV binary. Grayscale and linear contrast fit in one ColorMatrix. A global threshold fits in a ColorMatrix with a steep slope, or a tiny `RuntimeEffect` (SkSL) shader. Sauvola/adaptive threshold needs a shader with local mean sampling (blur + compare). Skia needs Reanimated 4 + worklets and adds several MB of native code per ABI **(unverified binary size)**. The docs pages were unreachable (503), so the exact SkSL/offscreen API should be checked against 2.14.
- fast-opencv gives the full classic pipeline, including contour-based document detection and warpPerspective. The cost is the OpenCV native library (roughly tens of MB per Android ABI for the full `libopencv_java4.so` **(unverified)**), a mismatch between OpenCV 4.9 on iOS and 4.12 on Android, and a dependency on one maintainer. Neither fast-opencv nor the scanner plugin has an Expo-documented config plugin for fast-opencv. Autolinking plus a dev build should be enough **(unverified)**.
- VisionCamera is for live frames. SplitIt captures stills, so it adds complexity without benefit unless live edge overlay is wanted.
- Apple Vision and ML Kit text recognizers (via `expo-mlkit-ocr`) are already robust to grayscale/contrast issues. On native, the biggest wins are usually framing, perspective and resolution, which is exactly what the OS document scanner gives.

### Gaps
- Not verified: SDK 57 compatibility of each third-party module (no Expo SDK 57 compatibility table fetched), and actual added binary size (IPA/APK delta) for Skia, fast-opencv and the scanner plugin.
- Not verified from Apple/Google docs: VisionKit `VNDocumentCameraViewController` being the iOS backend of `react-native-document-scanner-plugin`, and its min iOS version. The iOS podspec grep returned no dependency lines. Background knowledge **(unverified)**: the iOS side uses VisionKit's document camera (iOS 13+), and ML Kit Document Scanner needs Android API 21+ with Google Play services and ~1.7 GB RAM.
- No timing data found for any of these on mid-range phones.
- Not reviewed: `expo-image`. It is a display component and is not expected to provide pixel filters for export **(unverified)**.

## Best value for SplitIt

### Takeaway
On native, replace hand-written CV with the OS document scanner: `react-native-document-scanner-plugin`, MIT, a config plugin, ML Kit Document Scanner on Android and (reportedly) VisionKit on iOS. It does auto-crop, perspective correction and enhancement with almost no code, and its output feeds straight into `expo-mlkit-ocr`. Keep `expo-image-picker` as the fallback (gallery import, or devices without Play services). On web, write a small typed-array pipeline in `lib/` (grayscale, contrast stretch, Otsu/Sauvola, upscale), loaded lazily in the Tesseract chunk, and use Tesseract.js's built-in `rotateAuto`. Defer opencv.js/jscanify unless angled web photos show up as a measured failure mode.

### Cited Findings
- The scanner plugin is MIT, 54 KB of JS, wraps `play-services-mlkit-document-scanner` on Android, and integrates via an Expo config plugin (no Expo Go) — [README](https://github.com/websitebeaver/react-native-document-scanner-plugin), [build.gradle](https://github.com/websitebeaver/react-native-document-scanner-plugin/blob/master/android/build.gradle)
- opencv.js costs ~10.5 MB (official 4.13.0) to ~13.3 MB (techstark) of JS — [docs.opencv.org](https://docs.opencv.org/4.13.0/opencv.js), [jsDelivr](https://data.jsdelivr.com/v1/packages/npm/@techstark/opencv-js@5.0.0-release.1)
- Tesseract.js 7 already provides `rotateAuto` deskew and `imageBinary` debug output — [worker-script source](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js)

### Inferences
- Licensing is clean for every recommended option: MIT for the scanner plugin, Skia, fast-opencv, jscanify and image-js, and Apache-2.0 for opencv.js and Tesseract.js. The ML Kit Document Scanner is subject to Google's ML Kit terms **(unverified, not fetched)**.
- A pure-function web pipeline fits project conventions: `lib/` with `*.test.ts` and no new dependency. It can be measured with the `receipt-eval` skill before and after.
- If the scanner's built-in "filter" modes turn out to hurt OCR (for example over-sharpening thermal-paper text), a Skia ColorMatrix pass is the next-cheapest native step before reaching for OpenCV.

### Gaps
- No head-to-head accuracy data (OS scanner output vs raw photo + Vision/ML Kit) on receipts was found. This needs an on-device experiment with SplitIt's fixtures.
- Not verified: whether the ML Kit scanner UI lets the app force "no filter" mode, or whether the plugin exposes a scanner mode option (BASE / BASE_WITH_FILTER / FULL).
