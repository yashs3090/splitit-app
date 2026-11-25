# 0018: Every scan goes through one staged, measured pipeline

**Status:** Accepted (2026-11-25), for the architecture. **What ships on web is not decided yet** (decision S-1 in `docs/decisions-to-review.md`): the user is checking more answer files before Task 14 is re-run. Today every stage beyond "resize and read" is switched off, so scans behave as before (see "What ships today").

Spec: `docs/specs/2026-11-22-web-opencv-preprocessing.md` (Amendments A1–A5, Results log, "Decision (proposed), 2026-11-24"). Builds on [0010](0010-on-device-ocr-no-custom-backend.md) (read on device, no backend) and [0012](0012-receipt-capture-and-recognition-libraries.md) (the recognizers). OpenCV on web has its own ADR: [0019](0019-opencv-on-web.md).

> **Numbering note (2026-11-25):** the spec asked for 0015 (this ADR) and 0016 (OpenCV). Other sessions had already used 0015–0017 by the time this was written, so they became 0018 and 0019.

## Context
Before this, a scan was one straight line: take the photo, shrink or enlarge the **whole photo** to a size rule, read it, parse it, open the form. Three problems came out of real receipts:

1. **A small receipt in a big photo stays small.** `diff-quantity-size` is a 480 × 640 photo of a receipt that covers about 40% of a marble table. The size rule enlarged the whole photo, so the receipt's text stayed tiny, and the read found 0 of 5 items.
2. **When a read fails, the host just gets a broken form.** There was no "that didn't work, try again" and no clear "retake or type it in" choice.
3. **Every idea for improving reads was a guess.** Greyscale, contrast, Tesseract settings: each sounded good, and nobody could tell whether it helped.

The user asked for the fix to be permanent (decision D5 in the spec): "don't do it as a one-off thing — update the pipeline … a scanning stage as preprocessing that zooms into the image and increases quality". They also asked that **nothing be fitted to the test photos** (D3).

The research report (`reports/Receipt OCR preprocessing pipeline.md`) said the same thing in its title: "Fix geometry and scale, never binarize." Cropping and straightening help every engine; pixel filters mostly don't.

## Decision
### 1. One pipeline, six stages, on every platform
Every scan runs these steps, in this order:

```
locate the receipt → crop and flatten it → size the text → enhance (optional) → read → check quality
        └── if the check fails and a retry is configured: run the whole thing once more with another setup,
            keep the better of the two reads
        └── still not ok: "Retake photo / Type it in", with what was read filled in
```

| Stage | What it does | Example |
|---|---|---|
| `locateDocument` | Finds the receipt's four corners and says how sure it is (0–1) | Corners of the paper on the marble table, confidence 0.84 |
| `cropAndFlatten` | Cuts the receipt out and straightens it. **Does nothing** if the confidence is below `minConfidence` (0.5) | A tilted receipt becomes an upright rectangle |
| `normalizeScale` | Applies the size rule **to the crop**, not the whole photo | The crop's text is enlarged; the table isn't |
| `enhance` | Grey, flatten uneven light, gentle contrast. **Never black-and-white** | Off today |
| `recognize` | Reads the text (Vision, ML Kit or Tesseract.js) | Lines with boxes |
| `assessQuality` | Pure rule: did the read work? | "No total found" |

Each stage is a small interface (`StageSet`, `lib/scanPipeline/types.ts:154`). Each platform supplies its own implementation:
- **Web:** `lib/scanPipeline/web/stages.ts` (`createWebStages`, `:140`). Locate, crop and enhance use OpenCV in a Web Worker ([0019](0019-opencv-on-web.md)); reading uses Tesseract.js.
- **iPhone and Android:** `lib/scanPipeline/native/stages.ts` (`createNativeStages`, `:18`). For now these are **stubs** that do exactly what the app did before: locate finds nothing, crop and enhance return the photo unchanged, size uses today's `prepareForRecognition`, and read uses Vision / ML Kit. The phones' own document scanners (VisionKit, ML Kit Document Scanner) need a development build and belong to a later native spec.

The orchestration itself is pure code that doesn't know which platform it runs on (`runScanPipeline`, `lib/scanPipeline/run.ts:56`). The same file runs in the app, in a headless browser for measurement, and in Jest with fake stages.

### 2. Everything is configuration, and nothing ships without a measurement
- **Variants:** each way of running the pipeline is a named entry in `VARIANTS` (`lib/scanPipeline/config.ts:282`), for example `web-current` (today) or `web-crop-canvas` (crop first). A rejected variant stays in the list so it can be re-measured later.
- **Plans:** a plan is a primary variant plus an optional retry variant (`WEB_PLANS`, `:329`).
- **What ships:** `PIPELINE` (`:347`) picks one plan per platform. `WEB_CV_PREPROCESS` (`:358`) is the master switch for OpenCV on web.
- **The rule for shipping a stage:** it must beat today on the **tuning** receipts by more than a noise margin, without hurting any receipt by more than one item, and then not lose on the **held-out** receipts (`decide`, `lib/receiptEval.ts:335`). The core crop only has to do **no harm** (`decideCore`, `:340`), because the user asked for it as the first step (D4).
- Every number in the config has a `Why:` comment (the general reason) and a `Tuned:` comment (what the measurement said).

### 3. One quality rule, one retry, then the user decides
`assessQuality` (`lib/scanPipeline/assessQuality.ts:25`) reports problems: no items, fewer than 5 lines, no total, or the totals don't add up. The totals check is the parser's own `checkTotals` with its ±1¢ tolerance, imported, not copied, so the scan can never disagree with the form's "Adds up".

When two reads compete (a retry, or a second text-size pass), `pickBetter` (`:60`) keeps the one that found more of the receipt first, and only then the one whose numbers are closer (Amendment A5; details in [the scan pipeline note](../concepts/scan-pipeline.md)).

If the best read still isn't ok, the screen shows "We couldn't read this receipt clearly." with **Retake photo** and **Type it in** (`lib/scanScreen.ts:30`). "Type it in" opens the form with whatever was read.

### 4. A stage that breaks never breaks the scan
If OpenCV doesn't load, times out or crashes, that stage throws `StageUnavailable` and becomes "do nothing" for the rest of the scan (`run.ts:83-88`). The scan carries on with the whole photo, which is exactly today's behaviour. Only reading itself can fail a scan.

## What ships today (checked in the code 2026-11-25)
- `PIPELINE.web = WEB_PLANS.current` (`web-current`, no retry) and `WEB_CV_PREPROCESS = false` (`config.ts:347-358`). Web reads exactly as before; OpenCV is never fetched.
- `PIPELINE.native` is `native-current`, no retry: the stubs above.
- The quality check and the failure screen **are live** on both platforms (`SHOW_FAILURE_SCREEN = { web: true, native: true }`, `config.ts:364`; native by the user's choice Q6). So a read that doesn't add up now lands on "Retake photo / Type it in" instead of going straight to the form. Whether small mismatches should do that is open (decision S-2).
- **Proposed, not applied:** turn on the crop alone on web (`WEB_PLANS['crop-canvas']`, plus `WEB_CV_PREPROCESS = true`). It is waiting on the user's answer checks (S-1).

## What was measured (provisional: 3 tuning + 2 held-out receipts checked, against a minimum of 12 + 8)
| Step | Result | Shipped? |
|---|---|---|
| Crop to the receipt (`web-crop-canvas`) | Tuning items found 4/11 → 8/11, all from `diff-quantity-size`. Held-out unchanged, because the crop didn't fire on either held-out photo | Proposed (S-1) |
| Text-height second pass (28–46 px) | No change on checked receipts. On an unchecked photo (El Chalan), 34 and 40 px undo the one read the crop made worse | No (likely next, S-1) |
| Grey / flatten light / CLAHE | Ties or worse; CLAHE lost totals | No |
| Tesseract settings (thresholding, DPI, rotate, dictionaries) | No change or worse | No |
| Zoom on doubt | No change; one confident wrong fix ($35 → $36) | No |
| Strip tiling for long receipts | Did nothing on real photos (none was long). On a made-up 100-item receipt: 74 → 97 items | No (needs a real long receipt) |
| Retry pairs | Never better than the crop alone on tuning | No |

Web line-item accuracy (2026-11-24): 72.7% on tuning with the crop (36.4% today), 8.3% on held-out either way. Both are below ADR 0010's 85% line. Full table and reasoning: [the scan pipeline note](../concepts/scan-pipeline.md#how-the-decisions-were-made).

## Options considered
| Option | For | Against |
|---|---|---|
| **One staged pipeline for every platform, behind interfaces, measured** (chosen) | One place to add a step; native gets the same retry and failure screen; every step can be switched off and re-measured | More code than a one-off fix; the native stubs do nothing yet |
| A one-off "crop, then grey" fix in the web scan | Small | The user asked against it (D5). No way to tell whether it helps, and nothing to reuse on native |
| Only the phones' document scanners | Free and good on native | Web has no OS scanner; doesn't give a retry or quality rule |
| A server-side cleanup model (dewarping, super-resolution) | Strongest pixels | Needs a backend, which ADR 0010 rules out |

## Consequences
- **New stages are cheap to try and cheap to drop.** Add a variant, run the harness, run the eval. A step that loses stays in `VARIANTS` and never reaches `PIPELINE`.
- **The decision rules need data.** With 5 checked receipts, every verdict is provisional. More answer files are the main way to make progress (see [receipt answers](../../setup/receipt-answers.md)).
- **The failure screen is already on.** That changes what hosts see even with every new stage off (S-2).
- **The native stages are placeholders** until the native spec. The interfaces are designed so VisionKit or ML Kit's scanner can report `method: 'os-scanner'` without other changes.
- Before production: `docs/before-production.md` §4 tracks the small receipt set, the unchecked phone Safari behaviour and the OpenCV download size.

## Code
- Stage interfaces and types: `lib/scanPipeline/types.ts` (`StageSet` `:154`, `PipelineConfig` `:187`, `ScanProblem` `:199`)
- Orchestration: `lib/scanPipeline/run.ts` (`runScanPipeline` `:56`)
- Quality rule: `lib/scanPipeline/assessQuality.ts` (`assessQuality` `:25`, `pickBetter` `:60`)
- Config: `lib/scanPipeline/config.ts` (`VARIANTS` `:282`, `WEB_PLANS` `:329`, `PIPELINE` `:347`, `WEB_CV_PREPROCESS` `:358`, `checkPlan` `:396`)
- Entry points: `lib/scanReceipt.web.ts` (`scanReceipt` `:39`), `lib/scanReceipt.native.ts` (`scanReceipt` `:15`)
- Screen copy and outcomes: `lib/scanScreen.ts` (`PROGRESS_COPY` `:10`, `FAILURE_COPY` `:30`, `scanOutcome` `:69`)
- Eval and decision rules: `lib/receiptEval.ts` (`decide` `:335`, `decideCore` `:340`, `simulateFlow` `:352`)

Line numbers as of 2026-11-25; other sessions edit these files, so search for the symbol name if a line has moved.

## Learn more
- Concept note: [The scan pipeline](../concepts/scan-pipeline.md)
- Research report: `reports/Receipt OCR preprocessing pipeline.md`
- Tesseract, Improving the quality of the output: https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html
- Apple, `VNDocumentCameraViewController`: https://developer.apple.com/documentation/visionkit/vndocumentcameraviewcontroller
- Google, ML Kit Document Scanner: https://developers.google.com/ml-kit/vision/doc-scanner
