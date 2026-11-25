# Tesseract (v4/v5 LSTM) and Tesseract.js 7 preprocessing for phone photos of receipts

Scope note: most of the findings below about internals come from reading the source: upstream `tesseract-ocr/tesseract` main, plus the fork that tesseract.js-core 7.0.0 builds from. Findings about preprocessing benefits rest on weaker evidence (a forum experiment, a maintainer comment, one paper's abstract or snippet). I found no peer-reviewed benchmark of preprocessing for Tesseract LSTM on camera photos of receipts. Labels such as "(unverified)" and "(secondhand)" mark claims I could not read in the primary source.

## 1. What Tesseract does to the image internally, and which thresholding knobs tesseract.js 7 exposes

### Takeaway
Tesseract always binarizes internally (global Otsu by default, with Leptonica adaptive Otsu or Sauvola as options since 5.0). The binary image drives layout analysis and line and word segmentation. The LSTM recognizer is not fed binary pixels: it crops each line or word from the original grey or colour image (`BestPix()`) and rescales the crop to the network's fixed input height. Every `thresholding_*` parameter is a normal (non-init) variable in the Tesseract fork that tesseract.js-core 7.0.0 bundles, so `setParameters` or per-call `recognize` options can set them. Their sizes are multiplied by the image DPI, which is 70 for a typical browser JPEG unless you set `user_defined_dpi`.

### Cited Findings
- **Thresholding parameters (upstream main, `tesseractclass.cpp`):**
  - `thresholding_method`, default `Otsu`: "0 = Otsu, 1 = LeptonicaOtsu, 2 = Sauvola".
  - `thresholding_window_size = 0.33`: "Window size for measuring local statistics (to be multiplied by image DPI). This parameter is used by the Sauvola thresholding method".
  - `thresholding_kfactor = 0.34`: "Factor for reducing threshold due to variance … Sauvola … Normal range: 0.2-0.5".
  - `thresholding_tile_size = 0.33`: "Desired tile size (to be multiplied by image DPI) … LeptonicaOtsu".
  - `thresholding_smooth_kernel_size = 0.0`: "(to be multiplied by image DPI). Use 0 for no smoothing … LeptonicaOtsu".
  - `thresholding_score_fraction = 0.1`: "Fraction of the max Otsu score … LeptonicaOtsu".
  - `thresholding_debug = false`.
  - Source: [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp)
- **How each method is implemented ([thresholder.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/thresholder.cpp)):**
  - Sauvola calls `pixSauvolaBinarizeTiled(pix_grey, half_window_size, kfactor, nx, ny, …)`. It sets window = `max(7, window_size × yres)`, capped at the image's short side minus 3, and splits the image into tiles of "approx. 250 x 250 pixels".
  - LeptonicaOtsu calls `pixOtsuAdaptiveThreshold(pix_grey, tile, tile, half_smooth, half_smooth, score_fraction, …)` with tile = `max(16, tile_size × yres)`.
  - Method 0 (default) is Tesseract's own `OtsuThreshold`, computed over the whole rectangle: one global threshold per channel.
- **DPI handling ([baseapi.cpp `TessBaseAPI::Threshold`](https://github.com/tesseract-ocr/tesseract/blob/main/src/api/baseapi.cpp)):**
  - If `user_defined_dpi` is set it is always used ("Always use user defined dpi").
  - Otherwise, an image resolution outside 70–2400 is replaced with `kMinCredibleResolution` = 70. The constants are `kMinCredibleResolution = 70` and `kMaxCredibleResolution = 2400` in [publictypes.h](https://github.com/tesseract-ocr/tesseract/blob/main/include/tesseract/publictypes.h).
  - After thresholding, Tesseract sets an internal "estimated resolution" from text size and uses it for layout parameters, "rather than the image resolution, which may be fabricated".
- **The LSTM reads original pixels, not binary ones:**
  - `Tesseract::BestPix()` returns `pix_original_` if its width matches the image, else `pix_grey_`, else `pix_binary_` ([tesseractclass.h](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.h)).
  - `GetRectImage` in [linerec.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/linerec.cpp) crops the LSTM input from `BestPix()`. Its comment says "BestPix is never colormapped, but may be of any depth"; images below 8-bit are converted to 8-bit grey.
  - `Input::PrepareLSTMInputs` rescales each crop to `network->NumInputs()` (the input height) with `PreScale`. `PreparePixInput` turns it into "normalized grey" (or 24-bit colour if the network depth is 3) ([input.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/lstm/input.cpp)).
- **Maintainers confirmed this is intentional (PR #4111, closed unmerged in 2023):**
  - The PR proposed feeding the LSTM binarized crops. stweil: "I tested this commit on a greyscale newspaper image, and the result is mixed. Some lines were recognized better, others got worse. Generally it is intentional to use the LSTM with original images. Ideally the neural network was trained to handle noise and even to work better with greyscale images than with binarized images."
  - The author withdrew it: "feeding the engine B&W pixels is not the answer."
  - He also noted: "Anyone feeding tesseract monochrome (pre-thresholded/binarized) images from an external cleanup+binarization process … [gets] no difference between 'original pix' and 'binary pix'."
  - Source: [tesseract PR #4111](https://github.com/tesseract-ocr/tesseract/pull/4111)
- **Inversion:** `invert_threshold = 0.7`: "For lines with a mean confidence below this value, OCR is also tried with an inverted image". `tessedit_do_invert` is deprecated ("will be removed in release 6") — [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp). The FAQ notes that disabling inversion "brings extra speed" — [tessdoc FAQ](https://github.com/tesseract-ocr/tessdoc/blob/main/FAQ.md).
- **What tesseract.js 7 bundles and how it reads the image:**
  - tesseract.js 7.0.0 depends on `tesseract.js-core ^7.0.0` ([package.json](https://github.com/naptha/tesseract.js/blob/master/package.json)).
  - Its `third_party/tesseract` submodule points to the fork `Balearica/tesseract` at commit 2a9c1c4 (2025-12-11, "Optimize SSE intsimdmatrix for tesseract.js-core WASM SIMD build"). That fork's `VERSION` file says **5.3.0**, but it contains `thresholding_method`, all the Sauvola/LeptonicaOtsu params, `invert_threshold`, and the same `BestPix()` ([fork tesseractclass.cpp](https://github.com/Balearica/tesseract/blob/2a9c1c49c360462733c386d2a44fcd22c4e21411/src/ccmain/tesseractclass.cpp); [.gitmodules](https://github.com/naptha/tesseract.js-core/blob/master/.gitmodules)).
  - tesseract.js writes the encoded image bytes to `/input` and calls `api.SetImageFile(exif, angle)`, so Leptonica decodes the JPEG inside WASM. It parses EXIF orientation from the first 500 bytes ([setImage.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/utils/setImage.js)).
- **Setting parameters in tesseract.js 7 ([worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js)):**
  - `setParameters` calls `api.SetVariable` for every key except an init-only list: `ambigs_debug_level, user_words_suffix, user_patterns_suffix, load_system_dawg, load_freq_dawg, load_unambig_dawg, load_punc_dawg, load_number_dawg, load_bigram_dawg, tessedit_ocr_engine_mode, tessedit_init_config_only, language_model_ngram_on, language_model_use_sigmoidal_certainty`. Those must go in `createWorker`'s `config` argument (fixed in v5.0.4, #862 — [releases](https://github.com/naptha/tesseract.js/releases)).
  - `recognize(image, options)` also passes any non-tesseract.js option through as a Tesseract variable for that call only. It wraps the call in `SaveParameters()` and restores the previous values afterwards.
  - The tesseract.js-only options are `rectangle, pdfTitle, pdfTextOnly, rotateAuto, rotateRadians`.
- **Checking binarization in tesseract.js:** output flags `imageColor`, `imageGrey` and `imageBinary` return PNG data URLs of Tesseract's internal images via `api.WriteImage` ([dump.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/utils/dump.js)). `debug: true` captures Tesseract's debug log, which shows the window, tile and DPI values when `thresholding_debug=1`.
- **Official docs on binarization:** tessdoc says Tesseract binarizes internally with Otsu and that the result can be suboptimal, particularly with uneven background darkness. It says "Tesseract 5.0.0 added two new Leptonica based binarization methods: Adaptive Otsu and Sauvola" and to "Use `tesseract --print-parameters | grep thresholding_`" — [ImproveQuality.md](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md).

### Inferences
- Binarization (built-in or your own) mainly affects which lines and words Tesseract finds and how it slices them. Character recognition itself reads the grey or colour pixels you pass in, so the most direct lever on the LSTM is the grey image you supply. If you binarize before calling Tesseract, the LSTM sees your binary image, because the original is then binary. That discards anti-aliasing and faint-stroke information the model was trained to use (see stweil's quote).
- With no DPI in the JPEG (canvas `toBlob` JPEGs usually carry none, or a 72 dpi JFIF density; unverified for each browser), Tesseract uses 70 dpi. Sauvola's window is then about 23 px (0.33 × 70) and LeptonicaOtsu's tile about 23 px. Those windows are small next to text on a 2048 px receipt photo, so they can break up thick strokes or amplify paper texture. If you try method 1 or 2, set `user_defined_dpi` (for example 300) or tune the `*_size` factors, and check the result with `imageBinary`.
- Global Otsu (the default) handles uneven lighting worst: shadows from a hand or phone, curled paper, gradients across the photo. That is the usual camera-receipt case, and the strongest argument for trying `thresholding_method=2` or applying background flattening yourself.
- Because the LSTM rescales each line crop to a fixed input height, upscaling the whole image changes mostly segmentation and binarization behaviour, plus how much detail survives in the crop before downscaling. It does not change the resolution the network itself sees.

### Gaps
- I did not verify the exact `NumInputs()` input height of `eng` best and best_int (a figure of 36 px is often quoted; unverified).
- Not checked: whether the fork's thresholding code is identical to upstream main. The params match, but I did not diff `thresholder.cpp`.
- Not checked: what DPI Leptonica reads from browser-produced JPEGs.

## 2. Official guidance (tessdoc "Improving the quality of the output")

### Takeaway
The official guidance is short and qualitative. It recommends at least 300 DPI-equivalent (a capital-letter height target is linked rather than stated), dark text on a light background for 4.x, deskewing, about a 10 px border while avoiding huge borders, removing alpha, choosing a PSM, and disabling dictionaries for non-dictionary text. The "30–33 px capital height" rule of thumb comes from a community experiment on the mailing list, not from tessdoc.

### Cited Findings
All quotes in this list are from [ImproveQuality.md](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md) unless another source is given.
- **Rescaling:** "Tesseract works best on images which have a DPI of at least 300 dpi, so it may be beneficial to resize images." The page links to a test of optimal resolution with a "suggestion for optimal Height of capital letter in pixels". It gives no x-height number itself.
- **Binarisation:** see section 1. The page also suggests trying other algorithms (ImageJ, OpenCV, scikit-image) if the built-in one fails.
- **Noise:** "Certain types of noise cannot be removed by Tesseract in the binarisation step, which can cause accuracy rates to drop."
- **Dilation/erosion:** "Heavy ink bleeding from historical documents can be compensated for by using an Erosion technique." The same section covers dilation for thin or broken characters.
- **Rotation/deskewing:** "The quality of Tesseract's line segmentation reduces significantly if a page is too skewed." The advice is to "rotate the page image so that the text lines are horizontal."
- **Borders:**
  - OCR of a tight text crop with no border "can cause problems"; add a small border of about 10 px.
  - "Big borders (especially when processing a single letter/digit or one word on a large background) can cause problems … Please try to crop you input image to a text area with reasonable border (e.g. 10 px)."
  - "Scanned pages often have dark borders around them."
- **Inverted images:** for 4.x, "use dark text on light background".
- **Transparency:** "Tesseract 3.0x expects that users remove the alpha channel"; 4.00 "removes the alpha component by blending it with a white background."
- **PSM list (verbatim excerpt):** "3 Fully automatic page segmentation, but no OSD. (Default)", "4 Assume a single column of text of variable sizes.", "6 Assume a single uniform block of text.", "11 Sparse text. Find as much text as possible in no particular order.", "12 Sparse text with OSD.", "13 Raw line …".
- **Dictionaries and whitelist:**
  - "Disabling the dictionaries Tesseract uses should increase recognition if most of your text isn't dictionary words … setting both of the configuration variables `load_system_dawg` and `load_freq_dawg` to `false`."
  - "you can use the `tessedit_char_whitelist` configuration variable".
- **Tables:** "It is known tesseract has a problem to recognize text/data from tables … without custom segmentation/layout analysis."
- **Capital-letter height (secondhand; the thread would not load):**
  - In a 2018 tesseract-ocr mailing-list thread, a user (willus) tested Tesseract 4.0.0 with `eng.traineddata` across six fonts and many resolutions.
  - He reported that error rates tracked capital-letter height in pixels better than DPI. Errors reached zero around **30–33 px capital height**, and the DPI metadata itself had "virtually no impact".
  - Another poster in the same thread found about 200 dpi optimal, with `i`→`1` errors at much higher resolutions. A digits-only tester did not reproduce the 30–33 px finding.
  - Source: [Google Groups: Optimal image resolution for Tesseract 4.0.0](https://groups.google.com/g/tesseract-ocr/c/Wdh_JJwnw94) (summary from search results; I could not read the thread text).

### Inferences
- For a receipt photo resized to ≤2048 px on the long edge, a typical 80 mm receipt filling the frame vertically has roughly 40–70 lines. That gives a line pitch of about 30–50 px and a capital height of about 15–30 px. This is my arithmetic, not a measurement. Long receipts shot whole, or receipts shot from far away, will fall below the ~20–30 px target. Your planned upscaling should be driven by measured text height, not image size: for example, use `rowAttributes.rowHeight` from a first pass, or a connected-component height estimate. Aim for capitals of about 25–35 px rather than a fixed scale factor.
- Downscaling to 2048 px can push small receipts below the target. Consider cropping to the receipt before the size cap, so the pixel budget goes to paper rather than table.

### Gaps
- The willus thread's exact table and its upper bound (whether very large text hurts) could not be read directly.

## 3. Evidence on specific preprocessing steps for LSTM Tesseract

### Takeaway
Rigorous, LSTM-specific, camera-receipt evidence is scarce. The best-supported points are these:
- (a) Keep the input greyscale rather than pre-binarizing, because the LSTM was designed and trained for grey input.
- (b) Get text height into the ~20–35 px capital range.
- (c) Fix skew and uneven illumination, because these break segmentation.

Papers reporting gains from Otsu, convolution filters and similar steps mostly use scans or synthetic data, and their results do not transfer cleanly. I found no credible measured comparison of bicubic vs Lanczos, CLAHE, or unsharp masking for Tesseract LSTM.

### Cited Findings
- **Grey vs binary:**
  - stweil (maintainer): feeding binarized crops gave "mixed" results; "some lines were recognized better, others got worse", and grey input is the intended design — [PR #4111](https://github.com/tesseract-ocr/tesseract/pull/4111).
  - A DFKI paper on binarization-free OCR with LSTMs reports that grey-level text lines gave "24% and 19% lower error rates" on its low- and high-resolution sets than binarized recognition. This is a 1D LSTM on historical documents, not Tesseract (figures from the search snippet) — [DFKI: Binarization-free OCR for historical documents using LSTM networks](https://www-live.dfki.de/fileadmin/user_upload/import/9313_Binarization-free_OCR_for_historical_documents_using_LSTM_networks.pdf).
  - A Calamari-based study treats binarization and input line height as grid-search factors and reaches 0.44% CER on historical typefaces ([arXiv 2008.02777](https://arxiv.org/abs/2008.02777)). A search snippet attributed to it the claim that Tesseract models "work much better on grayscale input than on binarized input"; I could not confirm this in the abstract (unverified).
- **Otsu helping:** a comparative study of Tesseract, Keras, Paddle and Azure reportedly found that Otsu thresholding "substantially improves accuracy across all engines, particularly Tesseract", while Canny edge detection reduced performance. I did not see the dataset or numbers (snippet only) — [Synergizing OCR (academia.edu)](https://www.academia.edu/120306799/Synergizing_Optical_Character_Recognition_A_Comparative_Analysis_and_Integration_of_Tesseract_Keras_Paddle_and_Azure_OCR).
- **Convolution preprocessing:** a Symmetry 2020 paper on Tesseract 4.0 reports character-level accuracy rising from 0.134 to 0.616 with convolution-based preprocessing (snippet; the page returned 403, so I could not see dataset details) — [MDPI Symmetry 12(5):715](https://www.mdpi.com/2073-8994/12/5/715).
- **Receipts specifically:**
  - An Indonesian study compares Tesseract and EasyOCR on receipt ("nota") images before and after preprocessing, using CER. Snippets suggest Tesseract may have lost accuracy after thresholding (unverified) — [ResearchGate](https://www.researchgate.net/publication/399870864_PERBANDINGAN_AKURASI_TESSERACT_DAN_EASYOCR_SEBELUM_DAN_SESUDAH_PRAPEMROSESAN_PADA_CITRA_NOTA).
  - A receipt OCR paper reports that Tesseract 5.3.0, in default and receipt-tuned configs, was beaten by a fine-tuned TrOCR with 79% lower CER (snippet) — [Training Custom OCR Models for Retail or Utility Receipt Recognition](https://www.researchgate.net/publication/396848511_Training_Custom_OCR_Models_for_Retail_or_Utility_Receipt_Recognition).
- **Erosion and dilation:** official guidance limits these to ink bleed (erode) or thin or broken strokes (dilate) — [ImproveQuality.md](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md).

### Inferences
- **Likely to help on camera receipts** (inferred from the mechanics in section 1):
  - Crop to the receipt.
  - Correct perspective and deskew.
  - Convert to greyscale.
  - Flatten illumination: divide by a large-kernel blur or morphological closing of the background. This lets global Otsu segment well while the LSTM still gets clean grey pixels.
  - Upscale with a smooth kernel (bicubic or Lanczos; the difference is probably minor for text and unmeasured) until capitals are about 25–35 px.
  - Optionally apply mild contrast stretching.
- **Likely to hurt:**
  - Hard binarization before Tesseract. It removes grey levels from faint thermal strokes, and Otsu on faded thermal print can drop whole characters.
  - Aggressive denoising or median filtering, which can erase the gaps between dot-matrix dots and the `.` in prices.
  - Strong unsharp masking, which creates halos that segmentation can treat as strokes.
  - JPEG re-encoding at low quality, whose ringing around small text is similar.
- CLAHE can amplify paper texture and thermal-paper mottling. If used, keep the clip limit low and measure the effect. I found no measured evidence for or against it with Tesseract LSTM.
- Measure every step with the app's own receipt eval set (CER on item lines, plus item and price match rate). The published evidence is not specific enough to settle the question.

### Gaps
- I found no credible numbers on bicubic vs Lanczos vs super-resolution for Tesseract LSTM, on CLAHE, or on unsharp masking.
- I found no peer-reviewed benchmark of `thresholding_method` 0, 1 and 2 on camera photos.
- I could not get full text or numbers for several cited papers (403 errors, compressed PDF).

## 4. PSM, parameters, models and confidence output in tesseract.js 7

### Takeaway
PSM 6 (tesseract.js's default) assumes one uniform block. Community guidance favours PSM 4 for receipts with mixed font sizes, and PSM 11 for scattered text, but none of these modes separates item and price columns reliably. Compare 4 and 6 on the eval set. `tessedit_char_whitelist` is applied to the LSTM unicharset in current source, but a whitelist is risky for receipts, which need letters too. LSTM-only workers default to `4.0.0_best_int` `eng` data. Word and symbol confidence, plus alternative choices, are available, but only when you request `{ blocks: true }` in v6+.

### Cited Findings
- **PSM and defaults:**
  - `tessedit_pageseg_mode` defaults to `PSM.SINGLE_BLOCK` (6) in tesseract.js — [api.md](https://github.com/naptha/tesseract.js/blob/master/docs/api.md).
  - Typed `WorkerParams` lists `tessedit_pageseg_mode, tessedit_char_whitelist, tessedit_char_blacklist, preserve_interword_spaces, user_defined_dpi` — [index.d.ts](https://github.com/naptha/tesseract.js/blob/master/src/index.d.ts).
- **PSM for receipts (blog-level evidence):**
  - Guides describe PSM 4 as suited to receipts and invoices with variable text sizes, and PSM 6 as stricter, "assum[ing] uniform font and line spacing throughout" — [PyImageSearch PSM guide](https://pyimagesearch.com/2021/11/15/tesseract-page-segmentation-modes-psms-explained-how-to-improve-your-ocr-accuracy/); [imagetotable.ai guide](https://imagetotable.ai/blog/how-to-set-up-tesseract-ocr).
  - A Korean OCR book's benchmark lists PSM 4 for "일반 문서, 영수증, 명함" (general documents, receipts, business cards) — [wikidocs](https://wikidocs.net/441117).
  - Tesseract often merges columns across whitespace; "6 gives the exact same results as 3 (i.e. no column separation)" — [Google Groups: Failure to recognize columns](https://groups.google.com/g/tesseract-ocr/c/4JruAToLD84).
- **`preserve_interword_spaces`:** a bool, default `false`, "Preserve multiple interword spaces" — [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp).
- **`user_defined_dpi`:** int, default 0, "Specify DPI for input image". It overrides the image DPI and scales the thresholding windows (see section 1) — [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp); [baseapi.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/api/baseapi.cpp).
- **Whitelist with LSTM:**
  - Current source applies `tessedit_char_whitelist` and `tessedit_char_unblacklist` to `lstm_recognizer_->GetUnicharset()` for the main language and every sub-language (lines ~534–551 of [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp)).
  - In 4.0 alphas the whitelist was ignored under `--oem 1` ([issue #751](https://github.com/tesseract-ocr/tesseract/issues/751)). LSTM whitelist support came via [PR #2294](https://github.com/tesseract-ocr/tesseract/pull/2294), merged in 2019 per the search results.
- **Language data:** when `langPath` is unset, LSTM-only workers download from `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`; legacy-capable workers use `…/4.0.0` — [worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js). Self-hosting means serving that file yourself via `langPath` (no trailing `/`) — [api.md](https://github.com/naptha/tesseract.js/blob/master/docs/api.md).
- **Dictionaries:** `load_system_dawg`, `load_freq_dawg`, `load_number_dawg` and `load_punc_dawg` are init-only, so pass them in `createWorker(lang, 1, opts, config)` — [worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js); [api.md](https://github.com/naptha/tesseract.js/blob/master/docs/api.md).
- **Output formats:**
  - Defaults are `text: true` and everything else `false` (`blocks, layoutBlocks, hocr, tsv, box, unlv, osd, pdf, imageColor, imageGrey, imageBinary, debug`) — [defaultOutput.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/constants/defaultOutput.js).
  - v6.0.0 made this breaking change: "All outputs formats other than `text` are now disabled by default". The `blocks` output now returns only the `blocks` tree, with no flat word and symbol lists — [releases](https://github.com/naptha/tesseract.js/releases).
- **Confidence tree:**
  - `blocks` → `Paragraph[]` → `Line[]` → `Word[]` → `Symbol[]`. Each level has `text`, `confidence` and `bbox`.
  - `Line` adds `baseline` and `rowAttributes {ascenders, descenders, rowHeight}`, added in v5.1.0.
  - `Word` adds `choices: {text, confidence}[]` and `font_name`.
  - `Symbol` adds `is_superscript`, `is_subscript` and `is_dropcap`.
  - `Page.confidence` is `api.MeanTextConf()`.
  - Sources: [index.d.ts](https://github.com/naptha/tesseract.js/blob/master/src/index.d.ts); [dump.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/utils/dump.js); [releases](https://github.com/naptha/tesseract.js/releases).
- `lstm_choice_mode` (0, 1 or 2) adds alternative symbol choices in hOCR output. `lstm_choice_iterations` defaults to 5 — [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp).
- **v7.0.0:** about 15–35% faster than v6, a new `relaxedsimd` build, and Node 14 dropped — [releases](https://github.com/naptha/tesseract.js/releases). The core repo ships `tesseract-core-{,simd-,relaxedsimd-}lstm.wasm` variants ([tesseract.js-core repo](https://github.com/naptha/tesseract.js-core)). Self-hosted `corePath` directories therefore need the relaxedsimd files too (inferred from the v5 note that `corePath` "must contain all" core files).
- **`rotateAuto`:** when true, tesseract.js runs layout with PSM AUTO, reads `GetGradient()` or `GetAngle()`, and re-sets the image rotated if |angle| ≥ 0.005 rad. Otherwise it uses `rotateRadians` — [worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js).
- **Layout-only pass:** `layoutBlocks: true` with no recognition outputs skips recognition (`skipRecognition`) and returns layout blocks only — [worker-script/index.js](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js).

### Inferences
- **Filtering junk:** request `{ blocks: true }` and drop words or lines below a confidence threshold, for example 50–60. The cutoff should be tuned on the eval set; it is not sourced. Use `rowAttributes.rowHeight` to drop lines that are far off the median height (logos, barcodes) and to drive a second pass at a better scale.
- `preserve_interword_spaces=1` keeps the wide gap between an item and its price in `text`. That can make the parser's item/price split more reliable, but this is untested. Word bboxes from `blocks` are a stronger signal for column assignment.
- **Whitelist:** a full receipt whitelist (letters, digits, `$.,:-/%&@#*()`) would mainly suppress exotic glyphs. It can also force a wrong glyph where the right one was excluded, so post-filtering is safer.
- **Model choice:** `best_int` is the tesseract.js default and the only `eng` LSTM data on the jsDelivr path. Using `tessdata_best` (float) or `tessdata_fast` would mean self-hosting a different `.traineddata`. I found no measured receipt comparison.
- **Dictionaries:** disabling `load_system_dawg` and `load_freq_dawg` may help with abbreviated item names such as "CHKN SAND". This is untested; measure it.
- **`rotateAuto`** is a cheap deskew for small angles. Large skew or perspective distortion should be fixed before Tesseract.

### Gaps
- I found no measured PSM 4 vs 6 vs 11 comparison on camera receipts.
- I found no measurement of `best_int` vs `best` vs `fast` on receipts.
- I did not verify the exact semantics of tesseract.js's `GetJSONText` (whether symbol-level `confidence` is populated under LSTM in v7), beyond the type definitions.

## 5. Receipt-specific failure modes and mitigations

### Takeaway
Receipts break Tesseract in five predictable ways:
- Faded or low-contrast thermal print, where global Otsu drops strokes.
- Dot-matrix glyphs, where gaps between dots fragment characters.
- Two-column item/price layouts, which Tesseract merges or misorders.
- Small punctuation in prices (`.`, `,`, `:`, `$`) that is lost or confused.
- Uneven lighting and curl from phone capture.

Sourced evidence here is mostly anecdotal. The mitigations below follow from how Tesseract works internally.

### Cited Findings
- Tesseract struggles with tables and columns "without custom segmentation/layout analysis" — [ImproveQuality.md](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md). Users report columns merged across whitespace under PSM 3 and 6 — [Google Groups](https://groups.google.com/g/tesseract-ocr/c/4JruAToLD84).
- Skew "reduces significantly" the quality of line segmentation; uneven background darkness makes the internal Otsu result suboptimal — [ImproveQuality.md](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md).
- At very high resolutions one tester saw `i` misread as `1` (secondhand) — [Google Groups thread](https://groups.google.com/g/tesseract-ocr/c/Wdh_JJwnw94).
- `unrecognised_char` defaults to `|` ("Output char for unidentified blobs"). Stray `|` in output marks blobs Tesseract could not recognize — [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp).
- Light text on dark backgrounds (inverted header bands on some receipts) is retried inverted only when line confidence is below `invert_threshold` (0.7) — [tesseractclass.cpp](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccmain/tesseractclass.cpp).

### Inferences
- **Thermal fade:** flatten illumination and stretch contrast in grey before passing the image to Tesseract. Try `thresholding_method=2` (Sauvola) with `user_defined_dpi` set so the window covers several character heights. Do not hard-binarize the input yourself.
- **Dot-matrix:** a light Gaussian blur, or a small greyscale closing (dilation of dark ink), can join dots into strokes. This is the dilation case in tessdoc. Measure the effect, because it can also fill in counters in `8`, `0` and `6`.
- **Columns:** rely on word bboxes from `blocks` to pair items with prices by y-overlap, instead of trusting the reading order in `text`. Alternatively, run Tesseract on the left and right column crops separately using the `rectangle` option.
- **`$`, `.`, `:` confusion:** handle this in the parser, not the OCR. Normalize price tokens with a regex such as `\d+[.,:]\d{2}$` → cents. Treat `S`/`5`/`$` and `O`/`0` by context: a numeric column next to a `$` sign. Keep the decimal point by avoiding blur and denoising that erase small dots, and by keeping text near the ~30 px capital height.
- **Photo capture:** detect and crop the receipt, correct perspective, then size the result to the target text height. Doing this before the 2048 px cap matters more than any filter choice.

### Gaps
- I found no published, measured study of Tesseract LSTM error types (for example a confusion matrix for `.`/`,`/`:`/`$`) on thermal or dot-matrix receipts.
- I found no credible evidence on how well `thresholding_method` 1 or 2 handles thermal fade.
