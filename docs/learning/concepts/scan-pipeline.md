# The scan pipeline: stages, a quality check, and measuring before shipping

Decisions: [ADR 0018](../decisions/0018-staged-scan-pipeline.md) (the pipeline) and [ADR 0019](../decisions/0019-opencv-on-web.md) (OpenCV on web). Spec: `docs/specs/2026-11-22-web-opencv-preprocessing.md`. Research: `reports/Receipt OCR preprocessing pipeline.md`. Read [on-device OCR](on-device-ocr.md) first if "OCR" or "bounding box" is new to you.

## The idea
A receipt photo goes through a **pipeline**: a fixed list of steps (stages), each taking the previous step's image and handing on its own. Ours is:

```
1. locate     where is the receipt in the photo?          → four corners + "how sure" (0–1)
2. crop       cut it out and straighten it                → a flat, upright receipt (or the photo, if unsure)
3. size       make the text the right number of pixels    → the crop, enlarged or shrunk
4. enhance    grey, even out the light, gentle contrast   → (switched off today)
5. read       OCR: Vision, ML Kit or Tesseract.js         → lines of text with boxes
6. check      did that work? (pure rule, no pixels)       → ok, or a list of problems
```

If the check fails, the pipeline can **retry once** with a different setup and keep the better of the two reads. If it still fails, the host sees **"Retake photo"** or **"Type it in"**, with what was read already filled in.

Four ideas make this more than "a list of image filters":

**Geometry and scale come before filters.** OCR engines care most about two things: is the text straight, and is each letter the right number of pixels tall? Tesseract reads best when capital letters are roughly 20–35 px tall. Too small and strokes merge ("8" vs "3"); too large and it sees shapes it wasn't trained on. Cropping first means the size rule enlarges *the receipt*, not the table around it. Picture a 480 × 640 photo where the receipt fills 40% of the frame. Enlarging the whole photo to 1600 px makes the table bigger and leaves the receipt's text small. Cropping first, then enlarging, puts all of those pixels into the receipt. No filter can do that.

**Never turn the photo black-and-white.** "Binarize" means turning every pixel pure black or pure white. It sounds like it would help OCR, but Tesseract already does it internally, and only to find where lines are. Its neural reader (the "LSTM") then reads the **grey** pixels of each line. If you hand it a black-and-white image, the reader sees black-and-white too, and the information between black and white (a faded stroke, a thin decimal point) is gone. Tesseract's maintainers say using the original image is intentional. So our enhance stage only ever outputs grey with many levels, and a test checks that (more than 16 grey levels).

**Zooming adds no new information.** Enlarging an image doesn't create detail the camera didn't capture. A 253-px-wide photo enlarged 4× is still a 253-px photo, just blurrier and bigger. Zooming helps in only two cases: when the image was **shrunk** earlier (a tall receipt squeezed under the 2048 px cap: read it in strips at full size instead), and when the text is **too small for the engine's preferred range** (enlarge it into that range). That is why "zoom on doubt" (re-reading unclear rows enlarged) didn't help on our small photos: the rows had no detail the first read lacked.

**Nothing ships because it sounds good. It ships because it measured better on receipts it wasn't tuned on.** Each receipt is in one of two sets: **tuning** (where you look while choosing settings) and **held-out** (kept aside to confirm the choice once). If you pick a setting by looking at receipt A, it will tend to work on receipt A, even if it's useless in general. That's **overfitting**: you learned the test, not the skill. The held-out set catches it, as long as you look at it only once per experiment and never re-tune afterwards.

## Why it matters here
- **Real failures were geometry and size, not "bad pixels".** The research report's diagnosis of SplitIt's failures: a 263 × 450 thumbnail read 0 of 9 prices (too small), "57.71" read as "57.1" (a decimal point lost), a stray "4" picked up from the table next to El Chalan. Cropping and sizing address all three. Filters address none.
- **One place for every future idea.** The user asked for a permanent pipeline, not a one-off fix (spec D5). The phones' own document scanners will plug in later as the native `locate` and `crop` stages, with the same check, retry and failure screen.
- **A failed read now gets a clear next step.** Before, a bad read dropped the host into a form full of wrong numbers. Now it says "We couldn't read this receipt clearly." and offers Retake / Type it in.
- **The user made "no fixes for just these photos" a rule** (spec D3). Every threshold has a general reason in a `Why:` comment, a test on made-up input, and a measurement on held-out receipts.

## How we use it
### The stages in code
Each stage is a method on `StageSet` (`lib/scanPipeline/types.ts:154`), and each platform supplies one:
- **Web:** `createWebStages` (`lib/scanPipeline/web/stages.ts:140`). Locate, crop and enhance run in the OpenCV worker ([ADR 0019](../decisions/0019-opencv-on-web.md)); size uses today's canvas resize; read uses Tesseract.js through one session per scan.
- **iPhone/Android:** `createNativeStages` (`lib/scanPipeline/native/stages.ts:18`). Stubs for now: locate finds nothing, crop and enhance return the photo, size and read are exactly what the app did before.

`runScanPipeline` (`lib/scanPipeline/run.ts:56`) runs the stages in order. It's pure: no React Native, no Expo, no browser APIs. The platform parts come in as the `StageSet`, so the same file runs in the app, in a headless browser and in Jest with fake stages.

Details worth knowing:
- **The crop is skipped when locate isn't sure.** Below `minConfidence` = 0.5 (`WEB_CROP`, `lib/scanPipeline/config.ts:42`), the crop returns the photo unchanged (`run.ts:124`). A wrong crop is worse than none.
- **Locate has two methods** (`locateDocumentMat`, `lib/scanPipeline/web/cv/locate.ts:406`). First it looks for a four-sided outline (edges → contours → a 4-corner shape covering at least 15% of the photo, corners near 90°). If that fails, it looks for a big, bright, low-colour blob (paper on a darker table). A white receipt on a white marble table can defeat both; then the crop is skipped, which is no worse than before.
- **The size rule is the same as before, applied to the crop:** shrink to 2048 px on the long edge if bigger, enlarge to 1600 px if the long edge is under 1000 px (`RECOGNITION_MAX_EDGE` and `RECOGNITION_UPSCALE`, `lib/imageSize.ts:4` and `:21`).
- **The optional text-height second pass** measures the median line height of the first read (`medianLineHeight`, `lib/scanPipeline/textHeight.ts:50`). If it's outside the target ±15% (`TEXT_HEIGHT_BAND`, `:37`), it resizes **the crop** (never the first read's image, so quality isn't lost twice) and reads again, keeping the better read (`run.ts:161-178`).
- **A broken stage never breaks the scan.** If OpenCV fails, that stage throws `StageUnavailable` and becomes "do nothing" for the rest of the scan (`run.ts:83-88`). Only reading can fail a scan.
- **Cleanup always runs.** Every image handle is freed in `finally`, on success, error and cancel (`run.ts:204-210`).

### Config: variants, plans and the switch
Everything is data in `lib/scanPipeline/config.ts`:
- **A variant** is one complete way to run the stages, by name (`VARIANTS`, `:282`). Examples: `web-current` (today), `web-crop-canvas` (find + straighten the receipt with OpenCV, then today's resize on the crop), `web-crop-th40` (that plus a text-height pass aiming at 40 px line boxes). Each experiment variant differs from its baseline by **one** thing, so a change in score has one cause.
- **A plan** is a primary variant plus an optional retry (`WEB_PLANS`, `:329`), e.g. `crop-th40-then-current`.
- **What ships** is `PIPELINE` (`:347`), one plan per platform, plus the OpenCV master switch `WEB_CV_PREPROCESS` (`:358`). `checkPlan` (`:396`) refuses a plan whose variants need OpenCV while the switch is off, because it would silently run without its crop and not be the thing that was measured.

**Today (checked 2026-11-25):** `PIPELINE.web` is `current` (no retry) and `WEB_CV_PREPROCESS` is `false`, so web scans are read exactly as before. `SHOW_FAILURE_SCREEN` is on for both platforms (`:364`), so the quality check and the failure screen are live. What ships next is the user's call (decision S-1).

### The quality check and `pickBetter`
`assessQuality` (`lib/scanPipeline/assessQuality.ts:25`) returns `{ ok, problems, gapCents }`. The problems:
- `no_items`: no items found;
- `too_few_lines`: fewer than 5 lines (`MIN_LINES`, `:20`). Any itemised receipt prints a header, an item and a total, so 4 lines means a fragment;
- `no_total`: no total found;
- `items_vs_subtotal`, `subtotal_vs_total`: exactly what the parser's `checkTotals` reports, ±1¢ per check. The tolerance is imported, never re-typed, so the scan and the form's "Adds up" can't disagree.

`gapCents` is how far off the totals are, added up. Boundary cases (shared with the form): a gap of exactly 1¢ is ok, 2¢ is not; 1¢ off on both checks is ok.

`pickBetter(a, b)` (`:60`) chooses between two reads (a retry, or a second size pass). It goes down this list and stops at the first line where they differ (Amendment A5):
1. ok beats not ok;
2. found items beats no items;
3. enough lines beats a fragment;
4. found a total beats no total;
5. smaller total gap;
6. fewer failed totals checks;
7. more items;
8. more lines;
9. a full tie keeps the first read.

**Why this order:** the first version put "fewer problems, then smaller gap" first. A read with **no total** has nothing to compare, so its gap is 0, and it beat a read that found the total but was $1 off. That's backwards: the read with a total is more useful (the form shows it, and the banner says by how much it's off). So "is anything missing?" comes first, and only then "how far off?". The gap size comes before the count of failed checks because two checks each off by 2¢ are closer than one check off by $50.

### Timeouts
| What | Limit | Where | Past it |
|---|---|---|---|
| OpenCV loading (download + compile) | 30 s | `CV_LOAD_TIMEOUT_MS`, `lib/scanPipeline/web/cvClient.ts:39` | Worker stopped; the scan continues without OpenCV |
| One OpenCV operation | 60 s | `CV_OP_TIMEOUT_MS`, `cvClient.ts:46` | Same |
| One Tesseract read | 30 s (the user's choice; was 90 s) | `RECOGNIZE_TIMEOUT_MS`, `lib/webOcrSession.ts:59` | The read fails with `timeout`. If it was the first read, the screen says "Reading took too long." If the scan already had a read (the timeout hit the text-height second pass or the retry), that read is kept and shown as usual, the trace records a `timeout` entry, and nothing more is tried (`runScanPipeline`, review fix R1, 2026-11-25) |

All three are starting values, not tuned on phones (`docs/before-production.md` §4).

When one OpenCV step fails (OpenCV gone, or one operation failed) but the photo itself is fine, the step falls back to today's path on the original photo and the trace records a `fallback`; only a photo that can't be decoded fails the scan (`cvStepFailed` in `lib/scanPipeline/web/stages.ts`, review fix R2, 2026-11-25). "The first time takes a little longer." stops showing only after a scan whose trace has no `unavailable` or `fallback` entry, i.e. OpenCV really ran (`cvRan` in `lib/scanScreen.ts`, R4).

### The screen
`lib/scanScreen.ts` holds every string the scan screen shows. Progress: "Preparing photo…" (with "The first time takes a little longer." on a device's first OpenCV download), "Reading receipt…", and "Taking a closer look…" during a retry (`PROGRESS_COPY`, `:10`). The failure screen's one-line reason is chosen from the first problem (`failureReason`, `:56`): "We found no items.", "We couldn't find the total." or "The items don't add up to the total." Nothing from a library or the photo is ever shown.

### Measuring: harness, answer files, eval
Three tools, run from the repo root. Step-by-step instructions are in [receipt answers](../../setup/receipt-answers.md).

1. **`npm run ocr:harness -- --variants <v1>,<v2>`** runs the app's real web pipeline (the same `run.ts` and `web/stages.ts`) in headless Chromium through Playwright, on every photo in `receipts/`. It writes `eval/receipts/<name>.<variant>.ocr.json`: the lines read, plus what each stage did and how long it took. It serves files only on `127.0.0.1`, fails the run if anything tries to reach another host, and never copies a photo (`scripts/ocr-harness/run.ts`).
2. **Answer files** say what each receipt really says: `receipts/answers/<photo name>.txt`, typed in dollars the way the receipt reads. `npm run answers:draft` pre-fills drafts from the app's read (marked `checked: no`). You fix them with the photo open and change the last line to `checked: yes`. `npm run answers:check` validates them and says whether each one adds up. **Only checked answers are scored**, so the app is never graded against its own guess. Format: `lib/receiptAnswers.ts`.
3. **`npm run eval`** scores reads against checked answers (`lib/receiptEval.ts`):
   - `npm run eval -- --variant web-crop-canvas`: one variant's scores;
   - `npm run eval -- --compare web-current,web-crop-canvas` (add `--core` for the crop): applies `decide` / `decideCore`;
   - `npm run eval -- --flow web-current,web-crop-th40`: replays the retry (check the primary, retry if not ok, `pickBetter`) over saved reads;
   - `--confirm`: also prints held-out numbers. Run it **once**, after choosing on tuning.

The set each receipt is in is decided once, from a hash of its name (about 60% tuning, 40% held-out), and stored in `eval/receipts/sets.json` (`assignSet`, `lib/receiptEval.ts:562`). Nobody chooses, so nobody can put the "easy" receipts in held-out. Receipts looked at before the split are always tuning.

### How the decisions were made
`decide` (`lib/receiptEval.ts:335`) adopts a step only if **all** of these hold:
- on tuning: items matched rise by at least max(2, 2% of expected items) (a noise guard); no receipt loses more than 1 item; junk items rise by at most 1; the number of correct totals doesn't fall;
- then on held-out, once: items matched don't fall; no receipt loses more than 1 item; correct totals don't fall.

`decideCore` (`:340`) is the same without the "must gain" clause: the crop only has to do no harm, because the user asked for it as the first step. Below 12 tuning + 8 held-out checked receipts, every verdict is **provisional** (Amendment A1).

The honest results (2026-11-24, Chromium on this Mac, 8 photos; **3 checked tuning + 2 checked held-out receipts**):

| Step | Tuning items found (of 11) | What happened | Verdict |
|---|---|---|---|
| Today (`web-current`) | 4 | Baseline. Held-out: 1 of 12 | — |
| Crop to the receipt (`web-crop-canvas`) | **8** | All +4 on `diff-quantity-size` (the small-receipt photo). Didn't fire on either held-out photo, so held-out says nothing about it. On unchecked El Chalan the crop **shrank** the text (crop 676 × 1174 is above the 1000 px upscale line, so lines went 35 → 24 px) and lost an item | ADOPT, provisional (S-1) |
| Text-height pass at 28 / 34 / 40 / 46 px | 9 / 8 / 8 / 8 | +1 at 28 is under the noise guard. 34 and 40 fix El Chalan's crop damage (unchecked) | Reject (no gain); 40 is the likely next adoption |
| Grey, then flatten light, then CLAHE | 7 / 7 / 7 | Grey alone moved reads around; CLAHE lost totals. No photo had strong shadows, which is what flattening is for | Reject |
| Tesseract settings (thresholding 0/1/2, DPI 300, rotate, dictionaries off) | 4–6 | Three were byte-identical to today; the rest lost totals or added junk | Reject |
| Zoom on doubt | 4 (8 on the crop) | Re-read rows mostly came back *less* confident; one confident wrong fix ($35 → $36) | Reject |
| Strip tiling | 8 | No real photo was tall enough to trigger it. On a made-up 100-item receipt: 74 → 97 items, junk 20 → 0 | Reject for now (needs a real long receipt) |
| Retry pairs (crop ↔ today, today → crop + text-height) | 8 (9 with the 28 px pass) | At most +1 over the crop alone, under the noise guard. Where no receipt was found, the retry re-read the same image | Reject |

Line-item accuracy on web: 72.7% on tuning with the crop (36.4% today); 8.3% on held-out either way. ADR 0010's bar is 85%.

**Why most steps were rejected:** with 3 checked tuning receipts, a step has to find 2 more items to count at all. Most steps changed nothing on those 3, so the rule said no. That's the rule working: "no measurable gain" means "not worth the download, time and complexity yet". The steps stay in `VARIANTS` and get re-measured as more answer files are checked. The research predicted this for filters (neural readers want to be left alone); the crop was the one step every source agreed on, and it's the one that won.

## Pitfalls
- **Tuning on held-out.** Running `--confirm`, seeing a loss, tweaking, and running `--confirm` again turns held-out into tuning, and you lose your only honest check. Held-out runs once per experiment.
- **Grading the app against its own read.** A draft answer file is pre-filled from the app. Until a human fixes it and writes `checked: yes`, it agrees with the app by construction. The eval skips drafts for this reason.
- **Fitting a threshold to one photo.** "If the receipt is 676 px wide, enlarge it" fixes El Chalan and nothing else. Every constant needs a general reason (`Why:`) and a test on made-up input. Ask: would this rule make sense on a receipt I've never seen?
- **Changing two things at once.** If a variant adds the crop *and* a new resize, and the score moves, you can't tell which helped. The crop variant first used OpenCV's resize too; separating them showed the resize was hurting, which is why the shipping candidate uses the canvas resize.
- **Measuring the wrong image.** Because a broken stage quietly becomes "do nothing", a cv variant whose OpenCV failed to load would still "run" and save today's read under the new variant's name. (`npm run web` deleting `public/opencv/` mid-run could cause exactly that.) Since Task 9 the harness builds its own private copy of OpenCV and fails the run if a cv stage was unavailable, made no OpenCV call, or loaded impossibly fast (`scripts/ocr-harness/checks.ts`).
- **Binarizing "to help".** Feeding Tesseract a black-and-white image removes the grey detail its reader uses. Steer Tesseract's own thresholding instead, and only with evidence.
- **Expecting zoom to add detail.** Enlarging a small photo can put text into the engine's preferred size range, but it can't add strokes the camera didn't record.
- **Assuming the harness is a phone.** It's Chromium on a Mac, with OpenCV served from localhost (no download). iPhone Safari, phone memory and real download times are unchecked.
- **A retry that reads the same image.** If no crop was found and the text size is already in range, the "different" retry variant reads the same pixels the same way: about 1–1.5 s for nothing. A skip for that case is noted in the spec but not built.

## Check yourself
1. A receipt covers 40% of a 480 × 640 photo. Explain, in pixels, why cropping before the size rule gives Tesseract bigger letters than enlarging the whole photo.
2. Tesseract binarizes internally anyway. So why does handing it a black-and-white image hurt?
3. Read A found no total. Read B found the total but is $3.00 off. Under the old `pickBetter`, which won and why? Under the current order, which wins, and at which step?
4. A new variant gains 3 matched items on tuning, then loses 2 items on one held-out receipt. What does `decide` return, and which clause? What are you *not* allowed to do next?
5. Why does the eval refuse to score `checked: no` answer files?
6. The crop scored +4 items on tuning and changed nothing on held-out. Why doesn't held-out prove the crop is safe in this case?
7. "Zoom on doubt" re-reads a blurry price at 4× size. On a 253-px-wide photo, why is it unlikely to help? On which kind of photo might it?
8. With `WEB_CV_PREPROCESS = false`, can `PIPELINE.web` point at `crop-canvas`? What stops it, and why is that a good thing?

## Learn more
- Tesseract, Improving the quality of the output (scale, borders, binarization, page modes): https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html
- Tesseract PR #4111 (maintainers on feeding the LSTM binarized images): https://github.com/tesseract-ocr/tesseract/pull/4111
- Tesseract.js API (recognize options, `rotateAuto`, `imageBinary`): https://github.com/naptha/tesseract.js/blob/master/docs/api.md
- OpenCV.js tutorials: https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html
- MDN, Using Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- Playwright (the harness's headless browser): https://playwright.dev/docs/intro
- Google, ML Kit text recognition (pixel size guidance): https://developers.google.com/ml-kit/vision/text-recognition/v2/android
- Research report: `reports/Receipt OCR preprocessing pipeline.md` ("Prioritized actions", "Experiment plan")
- Decisions: [ADR 0018](../decisions/0018-staged-scan-pipeline.md), [ADR 0019](../decisions/0019-opencv-on-web.md), [ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md)
