# Computer-vision and AI preprocessing of receipt photos before OCR

Scope: phone photos of restaurant receipts, read on device by Apple Vision / Google ML Kit (SplitIt's pipeline), plus classic engines (Tesseract) for comparison. Researched 2026-11-22 in about 17 search/fetch calls. Many primary PDFs (the DIBCO 2019 report, the full SROIE report, the OpenCV docs, ResearchGate) were blocked (HTTP 403) or only their abstracts could be read, so several numbers come from search-result excerpts of the papers. Those are labelled "(excerpt)". Items marked "[background, unverified this session]" come from general domain knowledge and had no source fetched here.

## Geometry: boundary detection, perspective, orientation, deskew, dewarping

### Takeaway
Cropping to the receipt and correcting perspective and skew is the step with the clearest, largest benefit, because skew hurts line segmentation badly. Both phone platforms ship on-device document scanners that already do edge detection and perspective correction. Learned dewarping roughly halves OCR character error rate (CER) on curved or crumpled benchmark pages, but the models are heavy, and the benchmark numbers are noisy.

### Cited Findings
- Tesseract docs: "The quality of Tesseract's line segmentation reduces significantly if a page is too skewed." The fix is to rotate the page so text lines are horizontal. — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- Tesseract docs: OCR on a text area with no border can fail, so add a small border (for example 10 px). Very large borders and dark scanner borders also cause errors, so crop to the text with a border of about 10 px. — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- `--psm 0` runs orientation and script detection (OSD) only. `--psm 3` (the default) is fully automatic page segmentation without OSD. — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- SROIE receipt system (CTPN detection + attention decoder): adding a pre-processing step that extracts the receipt area, plus OCR verification to ignore handwriting, improved accuracy on SROIE 2019. The full system reached 71.9% F1 on detection plus recognition. — [Deep Learning Approach for Receipt Recognition, arXiv 1905.12817](https://arxiv.org/abs/1905.12817) (abstract excerpt)
- Classic receipt cropping (CEIR project): grayscale, then Sobel gradient, then morphological closing with an elliptical kernel to find the receipt outline. — [CEIR GitHub](https://github.com/eadst/CEIR)
- Google ML Kit Document Scanner (Android, API 21+): on-device, with "accurate edge detection for optimal crop results". Its sample output is captioned "perspective corrected, wrinkle removed and grayscale filter applied". SCANNER_MODE_FULL adds ML-based image cleaning (erasing stains, fingers and so on). The app needs no camera permission, and the models are downloaded through Google Play services. — [ML Kit Document scanner](https://developers.google.com/ml-kit/vision/doc-scanner); [Android Developers Blog, Feb 2024](https://android-developers.googleblog.com/2024/02/ml-kit-document-scanner-api.html)
- Apple: `VNDocumentCameraViewController` (VisionKit) is a ready-made document-scanning camera UI. `VNDetectDocumentSegmentationRequest` / `DetectDocumentSegmentationRequest` (Vision) returns a document's segmentation mask and corner points. The sources disagree on availability: the newer Swift API is listed as iOS 18+, and a third-party guide lists the VN version as iOS 15+. — [Apple DetectDocumentSegmentationRequest](https://developer.apple.com/documentation/vision/detectdocumentsegmentationrequest); [Apple VNDocumentCameraViewController](https://developer.apple.com/documentation/visionkit/vndocumentcameraviewcontroller); [Apple forums thread 683397](https://developer.apple.com/forums/thread/683397)
- Dewarping, DocUNet benchmark, OCR CER with Tesseract (excerpt from the FDRNet paper's table): DewarpNet 23.95%, DocTr 20.00%, FDRNet 16.96%. — [Fourier Document Restoration, arXiv 2203.09910](https://arxiv.org/abs/2203.09910)
- DocTr's own ablation on a 30-image OCR subset: CER 0.68 on the distorted input, 0.38 with DewarpNet, 0.31 with GeoTr (DocTr's geometry module). So learned dewarping cut CER by roughly 50–55% relative to doing nothing. — [DocTr, arXiv 2110.12942](https://arxiv.org/abs/2110.12942) (excerpt)
- UVDoc authors' caveat (as relayed in the search excerpt): OCR scores have high variance, and Tesseract is sensitive to small input changes, so small CER differences between dewarpers should be read with care. OCR is usually scored on 25 text-rich images out of DocUNet's 130. UVDoc describes its own network as "relatively small" and claims state-of-the-art results on DocUNet. — [UVDoc, arXiv 2302.02887](https://arxiv.org/abs/2302.02887)
- Folded documents get their own method: "Unfolder" rectifies documents with a crease from folding in half. — [arXiv 2312.00467](https://arxiv.org/abs/2312.00467) (title only; no numbers read)

### Inferences
- For SplitIt, the cheapest high-value step is to use the platform document scanner (VisionKit `VNDocumentCameraViewController` on iOS, ML Kit Document Scanner on Android), or Vision segmentation corners plus a perspective warp, before text recognition. These run on device and need no backend. Expo would need a native module or a community package for them (not checked).
- [background, unverified this session] The classic DIY approach is grayscale, blur, Canny, findContours, keep the largest 4-point polygon (approxPolyDP), then getPerspectiveTransform/warpPerspective. Deskew is done with minAreaRect on the text pixels, a Hough-line angle, or a projection-profile search. These all work in OpenCV.js in a browser too. Long receipts often fill the frame, or have a low-contrast edge against a white table, and then contour detection fails. That argues for learned segmentation (the Apple/ML Kit scanners).
- Apple Vision and ML Kit text recognizers are designed for camera images and handle moderate rotation and perspective. The gain from deskewing is likely smaller for them than for Tesseract. No measured number was found.
- Learned dewarpers (DocTr, DewarpNet, UVDoc) are mostly PyTorch research models. Running them on a phone would need conversion (Core ML / TFLite) and a new native module. In practice that is server-side for now, which conflicts with ADR 0010's no-backend stance.

### Gaps
- No quantitative study found of skew angle against Apple Vision or ML Kit accuracy.
- No measured accuracy for Tesseract OSD (0/90/180/270) on receipts.
- No receipt-specific dewarping benchmark (long, curled thermal receipts) was found. DocUNet is mostly A4-like pages.
- Inference time and size of DocTr / UVDoc on mobile were not obtained.

## Resolution: target character size, DPI, upscaling and super-resolution

### Takeaway
What matters is the pixel height of characters, not DPI. Targets: ML Kit wants at least 16x16 px per Latin character, with no gain above 24x24 px. Tesseract does best at about 300 DPI, which means an x-height of 20 px or more, or a capital height of about 30–33 px (forum evidence). Bicubic upscaling of mildly low-resolution text works for Tesseract. Learned text super-resolution helps recognizers substantially on very low-resolution crops, but it is costly.

### Cited Findings
- ML Kit: "ideally each character should be at least 16x16 pixels". CJK needs 24x24 px. "For all languages, there is generally no accuracy benefit for characters to be larger than 24x24 pixels." Resolution and focus "significantly" affect accuracy. — [ML Kit Recognize Text (Android)](https://firebase.google.com/docs/ml-kit/android/recognize-text); [ML Kit v2 iOS](https://developers.google.com/ml-kit/vision/text-recognition/v2/ios)
- Tesseract "works best on images which have a DPI of at least 300 dpi". — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- x-height of 20 px or more is preferred for Tesseract (as relayed by iDigBio). — [iDigBio Resolution Requirements](https://www.idigbio.org/content/resolution-requirements)
- Willus Dotkom's 2018 tests on Tesseract 4 (mailing list, not peer-reviewed): the error rate correlated most strongly with capital-letter height in pixels, regardless of DPI or point size. A later post says his error rate dropped to about zero at a capital height of 30–33 px. Letters that were too large caused errors too (i read as 1, f as t, ; as :). One user needed digits about 92 px tall to fix a 4-digit number, so the optimum depends on the input. — [tesseract-ocr Google Group thread](https://groups.google.com/g/tesseract-ocr/c/Wdh_JJwnw94); [Incorrect OCR of 4-digit number](https://groups.google.com/g/tesseract-ocr/c/Ff9PRvJMapM/m/69F4FMGLAgAJ)
- Tesseract's LSTM rescales each text line to 36 px height internally, using linear interpolation and unsharp masking. Scans down to about 150 DPI can be bicubic-upscaled to 300 DPI with "still excellent" results. — [End-to-end OCR for ultra-low-resolution printed text, arXiv 2105.04515](https://arxiv.org/abs/2105.04515)
- Text super-resolution (TSRN on TextZoom, ECCV 2020; real LR/HR pairs taken with different focal lengths): ASTER accuracy goes from 47.2% on raw low-resolution input to 58.3% with TSRN (+10.1 points). TSRN beats LapSRN by more than 5 and 8 points on ASTER and CRNN. Accuracy on raw LR input falls with difficulty (easy/medium/hard: 62.4/42.7/31.6%). SR costs throughput (lower FPS). — [TextZoom/TSRN, arXiv 2005.03341](https://arxiv.org/abs/2005.03341)
- Later text SR results: TextDiff +2.0/+0.3/+0.6 points over prior SOTA (ASTER/MORAN/CRNN). The baselines differ from TSRN's, so these are not directly comparable. — [TextDiff, arXiv 2308.06743](https://arxiv.org/abs/2308.06743)

### Inferences
- A modern phone photo (12 MP or more) of a receipt filling the frame usually exceeds 16 px per character. Small print on long receipts photographed from far away may not. So for SplitIt, the main resolution actions are: send full-resolution images to Vision/ML Kit (don't downscale the capture), and guide the user to get close or take the photo in sections. Upscaling is rarely needed.
- TextZoom gains are measured on scene-text word crops at very low resolution (about 16x64). They should not be extrapolated to full receipt photos. SR models (ESRGAN-type) are server-class and can invent glyphs, a real risk for prices. [background, unverified this session: SR hallucination of digits]
- Don't upscale after binarizing. Interpolating a binary image produces jagged edges. Upscale the grayscale image first. [background, unverified this session]

### Gaps
- No published character-size curve for Apple Vision text recognition was found.
- No study found measuring ESRGAN or Real-ESRGAN as OCR preprocessing on documents.

## Color and contrast: grayscale, CLAHE, gamma, background normalization, shadow removal

### Takeaway
Uneven lighting and shadows are the main photometric problem in phone captures, and correcting them gives measurable OCR gains (one paper: 26% CER improvement). Learned shadow-removal networks (BEDSR-Net, FSENet) are the state of the art. Simple background division (image divided by a blurred or morphologically closed copy) is the cheap classic approach, but no head-to-head numbers for it were found.

### Cited Findings
- Tesseract's internal Otsu binarization "can be suboptimal, particularly if the page background is of uneven darkness". — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- Reflectance estimation as an OCR preprocessing step gave a 26% improvement in character error rate. It was compared against CamScanner, with Tesseract as the OCR engine. — [arXiv 2011.14447](https://arxiv.org/abs/2011.14447) (excerpt)
- ACCV 2016 (Bako et al.): estimate background and text color in local blocks and match them to a global reference to build a per-pixel shadow map. The aim is cleaner binarization for OCR while keeping color and tone. — [Removing Shadows from Images of Documents, ACCV16](https://web.ece.ucsb.edu/~psen/Papers/ACCV16_RemovingShadows.pdf)
- BEDSR-Net (CVPR 2020) is described as the first deep network built for document shadow removal. A background-estimation module also produces an attention map of shadow locations. — [BEDSR-Net](https://www.csie.ntu.edu.tw/~cyy/publications/papers/Lin2020BAD.pdf)
- Datasets: real document-shadow datasets have historically been small. Newer ones are RDD (large real-world) and SD7K (more than 7k real high-resolution shadow/shadow-free pairs, with the FSENet frequency-split network). — [arXiv 2309.06670](https://arxiv.org/abs/2309.06670); [arXiv 2308.14221](https://arxiv.org/abs/2308.14221)
- DocTr also includes an illumination-correction module, alongside geometric unwarping. A 2026 synthetic dataset targets unwarping and illumination together. — [DocTr, arXiv 2110.12942](https://arxiv.org/abs/2110.12942); [SyntheticDoc, arXiv 2609.15503](https://arxiv.org/abs/2609.15503) (title only)
- ML Kit Document Scanner includes "remove shadows" and filter options on device. — [ML Kit Document scanner](https://developers.google.com/ml-kit/vision/doc-scanner)

### Inferences
- Cheap, on-device candidates in rough priority order. All are [background, unverified this session] in effect size. (1) Grayscale (luma) conversion. (2) Background normalization: divide grayscale by a large-kernel median/Gaussian blur, or by a morphological closing with a kernel larger than stroke width, then rescale to 0–255. This flattens shadows and the yellowing or fading of thermal paper. (3) CLAHE with a moderate clip limit (about 2–3, 8x8 tiles) for low-contrast faded print. Heavy clipping amplifies paper texture and noise. (4) Gamma below 1 to darken faint thermal text.
- Apple Vision and ML Kit already handle reasonable color photos. Their biggest weaknesses are hard cast shadows (a phone or hand over the receipt) and glare, which preprocessing can't fully recover (glare saturates pixels). Capture guidance (avoid overhead light glare, no flash) probably matters more than filtering.
- All the classic operations are feasible on device and in a browser (OpenCV.js, or canvas pixel ops). Learned shadow removal is server-only, unless you use the platform scanner's built-in cleanup.

### Gaps
- No quantitative OCR comparison found for CLAHE vs background division vs none on receipts.
- No study found specifically on faded thermal-paper restoration.

## Noise filtering and sharpening

### Takeaway
There is little direct quantitative evidence. Engine docs say noise surviving binarization lowers accuracy, and Tesseract itself unsharp-masks lines internally. Small receipt digits make aggressive smoothing risky. Treat denoising as an A/B experiment, not a default.

### Cited Findings
- "Certain types of noise cannot be removed by Tesseract in the binarisation step, which can cause accuracy rates to drop." Bold or thin strokes reduce accuracy, and erosion can thin ink-bled glyphs. — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- Tesseract LSTM line normalization already applies unsharp masking when rescaling lines to 36 px. — [arXiv 2105.04515](https://arxiv.org/abs/2105.04515)
- A convolution-based preprocessing selector for Tesseract 4.0 (choosing among filters per image) raised accuracy from 0.38 to 0.63 (Tesseract) and from 0.93 to 0.96 (neural-net OCR), as summarized in the search excerpt. — [Improving the Accuracy of Tesseract 4.0 OCR Engine Using Convolution-Based Preprocessing, Symmetry 2020](https://www.mdpi.com/2073-8994/12/5/715)

### Inferences
- [background, unverified this session] Median 3x3 removes salt-and-pepper speckle (dot-matrix gaps, paper fibers) but can close the counters of small 6/8/9/0. Bilateral filtering and non-local means keep edges better but are slower (NLM in particular on a phone at 12 MP). A mild unsharp mask helps slightly blurry captures. Over-sharpening creates halos that binarizers turn into stroke artifacts. Motion blur is better handled by retaking the photo (blur detection with variance of the Laplacian) than by deblurring.
- The per-image filter selection gain above (0.38 to 0.63) suggests no single fixed filter is best. A fixed pipeline should be validated on SplitIt's own fixtures with the receipt-eval skill.

### Gaps
- No receipt-specific measurement of median vs bilateral vs NLM effects on OCR was found.

## Binarization: Otsu, adaptive, Sauvola/Niblack/Wolf, learned (DIBCO), and whether it helps neural OCR

### Takeaway
On degraded-document benchmarks, adaptive and learned binarizers beat global Otsu by a wide margin. For modern neural recognizers (LSTM/CRNN/transformer, including Apple Vision and ML Kit), evidence suggests that grayscale input matches or beats binarized input, and external binarization can hurt. Binarize only for classic engines, or as a measured experiment.

### Cited Findings
- Tesseract binarizes internally with Otsu. Tesseract 5.0.0 added Leptonica-based Adaptive Otsu and Sauvola (`thresholding_method` parameter). — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- DIBCO 2019 F-measure (FM, from the GDB paper's table, excerpt): Otsu 47.83, Sauvola 51.73, best competition entry 72.88, GDB (gated convolutions) about 73.5–73.9. — [GDB, arXiv 2302.02073](https://arxiv.org/abs/2302.02073)
- Another table for DIBCO 2019 Otsu: PSNR 12.67, FM 63.87, pseudo-FM 60.24, DRD 16.87. This conflicts with GDB's Otsu FM of 47.83, likely a different protocol. — [DocBinFormer, arXiv 2312.03568](https://arxiv.org/abs/2312.03568)
- A fair-evaluation study of deep binarizers found DE-GAN best overall across four DIBCO datasets, while the 2-Stage GAN struggled on DIBCO 2019's quadrille paper. The best method depends on the data and the training samples. — [A Fair Evaluation of Various Deep Learning-Based Document Image Binarization Approaches, arXiv 2401.11831](https://arxiv.org/abs/2401.11831)
- Binarization-free OCR: 1D LSTM on gray-level historical text lines reached up to about 25% gain versus binarized input (excerpt). — [DFKI, Binarization-free OCR for historical documents using LSTM](https://www.dfki.de/fileadmin/user_upload/import/9313_Binarization-free_OCR_for_historical_documents_using_LSTM_networks.pdf)
- Line-based CRNN evaluation: Tesseract's models did much better on grayscale than binarized input, and models trained on one binarization method degrade on another (search summary; the abstract itself does not give numbers). The study reached 0.44% CER on historical text with Calamari. — [On the Accuracy of CRNNs for Line-Based OCR, arXiv 2008.02777](https://arxiv.org/abs/2008.02777)
- ID-document study (2021): binarization changed recognition results, but the best recognition came from PaddleOCR on its own (no external binarization). The authors suggest that either the DL binarizers were not good enough or DL OCR already works well without preprocessing (search summary; the paper itself was blocked). — [Assessing the Relationship Between Binarization and OCR… ID Document Analysis (ResearchGate)](https://www.researchgate.net/publication/355885450)
- Video text overlays: Otsu was Tesseract's best preprocessing, but an identical result came with no preprocessing. CRNN convolution layers "essentially replace" preprocessing. — [arXiv 1804.10687](https://arxiv.org/abs/1804.10687)
- Counter-evidence (classic pipeline, IC labels): removing the binarization step caused one of the largest drops, about 40%. — [MDPI Electronics 12(11):2449](https://www.mdpi.com/2079-9292/12/11/2449)
- Nepali text with Tesseract: Otsu gave the best accuracy of the methods tested. — [Academia.edu](https://www.academia.edu/88982537/)

### Inferences
- For SplitIt (Apple Vision / ML Kit): don't binarize by default. These are neural recognizers trained on natural camera images. The evidence above says neural OCR does as well or better on grayscale, and hard thresholding destroys anti-aliasing and faint thermal strokes. If testing binarization, use Sauvola or adaptive Gaussian with a window larger than the character height (window roughly 2–3x the x-height, [background, unverified this session]), not global Otsu, because receipts have uneven lighting.
- Ordering: geometry, then background normalization, then optional mild denoise, then binarize (if at all). Deskew and warp first so the window statistics match text scale. Never upscale or rotate after binarizing.
- Feasibility: Otsu, adaptive mean/Gaussian and Sauvola are cheap on phone and browser (OpenCV.js; Sauvola via integral images). Learned binarizers (DE-GAN, DocBinFormer, GDB) are research PyTorch models, server-side in practice.

### Gaps
- No study found that measures binarization's effect on Apple Vision or ML Kit specifically.
- The official DIBCO 2019 report (Pratikakis et al.) and its rankings were not retrieved.
- No receipt-specific binarization A/B test was found for PaddleOCR or docTR.

## Receipt datasets, top-system preprocessing, receipt-specific issues

### Takeaway
SROIE (scanned, 1,000 images), CORD (about 1,000 Indonesian shop and restaurant receipts, v2 split 800/100/100) and WildReceipt (1,765 photos) are the standard datasets. Published top systems put their effort into detection, recognition and key-information models, not image preprocessing. The one documented preprocessing gain is cropping the receipt region. No source quantified thermal fade, folds or glare.

### Cited Findings
- ICDAR 2019 SROIE: 1,000 whole scanned receipt images. Three tasks: text localization, OCR, key information extraction. — [ICDAR2019 SROIE competition report, arXiv 2103.10213](https://arxiv.org/abs/2103.10213)
- Receipt-area extraction plus OCR verification improved SROIE accuracy in a CTPN-based system (71.9% F1 detection and recognition). — [arXiv 1905.12817](https://arxiv.org/abs/1905.12817)
- An end-to-end SROIE OCR method reported 64.4 F1 and 22.8% CER with no separate detection step (excerpt). — [arXiv 2212.05525](https://arxiv.org/abs/2212.05525)
- CORD: Indonesian receipts with box/text annotations and multi-level semantic labels. v2 split 800/100/100. Covers only shops and restaurants, collected in 2019. — [clovaai/cord](https://github.com/clovaai/cord); [HF dataset card](https://huggingface.co/datasets/Zarov888/consolidated_receipt_dataset)
- WildReceipt: 1,765 photos, 25 classes, about 50,000 text boxes. — [Papers with Code: WildReceipt](https://paperswithcode.com/dataset/wildreceipt)
- Receipt difficulties cited in the literature: poor scan quality, complex layouts, degraded text. A Vietnamese mobile-capture receipt challenge (2,436 images) included a task to predict receipt image quality. — [CORU, arXiv 2406.04493](https://arxiv.org/abs/2406.04493)

### Inferences
- The "receipt quality prediction" task suggests a practical idea for SplitIt: score capture quality on device (blur via Laplacian variance, glare via the share of saturated pixels, character height via the recognized box heights) and ask for a retake, rather than trying to repair bad photos. [inference]
- Long receipts: if one photo shrinks characters below about 16 px, take several photos, or use the scanner's multi-page mode and merge. [inference from the ML Kit size guidance]
- Dot-matrix print: a small morphological closing (dilation then erosion, 2–3 px) can join dots into strokes for classic engines. Effect on neural OCR unknown. [background, unverified this session]

### Gaps
- No preprocessing details of the top SROIE Task 2 entries were retrieved (the full report PDF was not read).
- ExpressExpense receipt dataset: no information retrieved.
- No quantitative sources on thermal fade, folds, glare or dot-matrix effects on OCR.

## Ordering of steps and pitfalls

### Takeaway
Evidence-backed order: crop and perspective-correct, then fix orientation and skew, then normalize illumination, then (optionally) gentle denoise, then resize to the target character height, then binarize only for classic engines. For neural on-device OCR, stop after illumination normalization, or even after geometry.

### Cited Findings
- Skew degrades segmentation, so rotate to horizontal before OCR. Keep a modest border of about 10 px. Use dark text on a light background. Remove the alpha channel. — [Tesseract ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)
- Character size has an optimum: too large also causes errors. — [tesseract-ocr Google Group](https://groups.google.com/g/tesseract-ocr/c/Wdh_JJwnw94)
- Neural OCR can be hurt by external binarization, and models are sensitive to the binarization method they were trained on. — [arXiv 2008.02777](https://arxiv.org/abs/2008.02777); [DFKI binarization-free LSTM](https://www.dfki.de/fileadmin/user_upload/import/9313_Binarization-free_OCR_for_historical_documents_using_LSTM_networks.pdf)
- OCR metrics are high-variance, so validate on your own set. — [UVDoc, arXiv 2302.02887](https://arxiv.org/abs/2302.02887) (as relayed)

### Inferences
- Recommended SplitIt pipeline, all on device, no backend, ranked by expected value:
  1. Platform document scanner (VisionKit / ML Kit Document Scanner): boundary detection, perspective correction and shadow cleanup, learned and on device. Highest value, supported by the CER gains from geometry and illumination.
  2. Full-resolution capture plus a retake prompt for blur, glare or tiny characters (based on the 16 px rule).
  3. Optional grayscale plus background division plus mild CLAHE, A/B-tested with the receipt-eval skill.
  4. Don't binarize, denoise heavily or upscale for Vision/ML Kit unless the A/B results show gains.
  5. Learned dewarping, super-resolution and shadow-removal networks: server-only, so out of scope under ADR 0010 unless the user decides otherwise.
- Pitfalls [background, unverified this session]: binarizing before deskewing (rotating binary images creates aliasing); upscaling after binarizing; CLAHE before shadow removal (amplifies shadow edges); a median filter large enough to fill digit counters; JPEG re-encoding between steps.

### Gaps
- No end-to-end ablation of a complete receipt preprocessing pipeline on Apple Vision or ML Kit was found. SplitIt should produce its own with the receipt fixtures.
