# Staged scan pipeline (web first, with OpenCV), the measurement tools it needs, and the scan flow

Date: 2026-11-22. Repo: `splitit-app` (single repo, ADR 0011). Backlog item 3. Web stages are built here. Native stages are identity stubs until the dev-build work.

Inputs:
- `reports/Receipt OCR preprocessing pipeline.md` ("Prioritized actions", "Experiment plan" E1–E7);
- `research_notes/Receipt OCR preprocessing pipeline/{implementation_options,tesseract}.md`;
- ADR 0010 / 0012;
- `docs/lessons/log.md`.

## User decisions already made (2026-11-22)
- **D1.** "lets add opencv to web". The user accepted the costs: about 10–13 MB extra download on the first scan that uses it, compile time, memory, and a `dist/` of about 28 MB.
- **D2.** Build both "smart chunk" ideas: **strip tiling for tall receipts** and **zoom on doubt**. Each is measured and flagged, but it is planned work, not an idea (Tasks 12–13).
- **D3.** **No fixes that only work for the current test receipts.**
  - Every rule, threshold and step must be general: justified by how receipts and OCR behave, not by one photo.
  - Thresholds are tuned on a **tuning set** and confirmed on a separate **held-out set**, so overfitting shows (C1).
  - Every new rule has a test case not derived from existing fixtures (criteria 70–73).
- **D4.** "we need something that will identify and zoom into the receipt — I like the scanning step as a preprocessing."
  - **Locate the receipt → crop and flatten → then size the text** is the core first step. It is not an optional experiment.
  - Every later stage works on the crop.
  - The size rule is applied to the **crop**, not the whole photo. Today a 480×640 photo is upscaled as a whole, so a receipt filling 40% of it stays small.
- **D5.** "don't do it as a one-off thing — update the pipeline … a scanning stage as preprocessing that zooms into the image and increases quality."
  - This is a **permanent, staged scan pipeline used for every scan on every platform** (C3).
  - Each stage sits behind a small interface with per-platform implementations, is configurable and flaggable, and is measured with the eval.
- **Earlier.** Tesseract.js assets are **self-hosted** (ADR 0012). OpenCV follows the same rule.

## Providers, accounts and costs

| Thing | What for | Cost / setup | Notes |
|---|---|---|---|
| `@techstark/opencv-js` (npm, Apache-2.0) | OpenCV in the browser (locate, warp, resize, enhance) | Free. Adds about 12–13 MB to `dist/` and to each user's first scan that uses it | Recommended build (next section). Exact pin |
| `tsx` (npm, MIT) | Runs `scripts/*.ts` (the receipt-eval skill already says `npx tsx`) | Free, dev only | Not installed today (checked `node_modules`) |
| `esbuild` (npm, MIT) | Builds the OpenCV Web Worker and the harness page | Free, dev only | Exact pin |
| `playwright` (npm, Apache-2.0) + Chromium (optionally WebKit) | Headless-browser harness that runs the exact web pipeline | Free, dev only. `npx playwright install chromium` downloads roughly 100–200 MB to `~/Library/Caches/ms-playwright` *(verify size)* | No account. Never in the app |
| Web host bandwidth | Serving `opencv.js` (~12 MB) beside Tesseract (~15 MB) | $0 on free tiers at friend-test scale *(unverified per host)* | Listed in `docs/before-production.md` (Task 15) |
| Real receipt photos | Ground truth for the eval | User time: about 2–5 min per receipt to correct a pre-filled `expected.json` | Kept in gitignored `receipts/` and `eval/receipts/` |

There is no paid service, no new account and no backend (ADR 0010 holds). Native OS scanners (VisionKit, Vision segmentation, ML Kit Document Scanner) are free on-device APIs, but they need the dev build. That belongs to the later native spec.

## OpenCV build: recommendation

| Option | Size | License / version (checked 2026-11-22) | For | Against |
|---|---|---|---|---|
| Official `docs.opencv.org/4.13.0/opencv.js` | 10,964,323 bytes (HEAD, uncompressed) | Apache-2.0. Not on npm | Smallest prebuilt | Not in `package-lock.json`. Self-hosting means vendoring an 11 MB binary or a fetch-at-build script with a hash pin |
| **`@techstark/opencv-js` `4.12.0-release.1`** (recommended) | 12,298,343 bytes unpacked package; `dist/opencv.js` is most of it *(verify the file size after install)* | Apache-2.0, published 2025-11-08. Repackages the official build and adds TS types | Pinned and integrity-checked by the lockfile. Copied from `node_modules` like the Tesseract assets. Has TS types. Documented for both browser and Node, so the harness and Jest load the same file. On the stable 4.x line the research cites | About 1–2 MB larger than the official 4.13 file |
| `@techstark/opencv-js` `5.0.0-release.1` | 13,298,869 bytes `dist/opencv.js` | Apache-2.0, published 2026-06-24 | Newest | New major line, and the largest |
| Custom minimal build (imgproc only) | Probably a few MB *(unverified)* | Same | Far smaller download | Needs emsdk and an OpenCV source build, plus upkeep. Kept as a before-production size fix once the winning steps are known |

**Recommendation:** `@techstark/opencv-js@4.12.0-release.1`, exact pin, self-hosted. That matches the ADR 0012 reasons: privacy, pinned versions, CSP, and no third-party dependency. I found no real reason to use a CDN for this; it would only save bandwidth.

**Loading** (*verify* items are tool facts to check against the installed versions):
- Metro never bundles OpenCV.
- A copy script puts `opencv.js` and its LICENSE in `public/opencv/` (gitignored).
- esbuild builds `lib/scanPipeline/web/cv/worker.ts` into `public/opencv/receipt-cv-worker.js`. This is a classic Web Worker that sets `self.Module = { onRuntimeInitialized }` before `importScripts('/opencv/opencv.js')`. A forum report says assigning `cv.onRuntimeInitialized` afterwards never fires. *(Verify on 4.12. If techstark exposes `cv` as a Promise, await it.)*
- The app reaches the worker only through `lib/scanPipeline/web/cvClient.ts`, and only from the lazily imported web stage set.

## Goal
Every scan goes through the same staged pipeline: find the receipt, crop and flatten it, size the text, enhance it if that engine benefits, read it, and check the result. More receipts then read correctly the first time on web. When a read fails, the host gets one automatic second try, then a clear "Retake photo / Type it in" choice with what was read already filled in. Every stage that ships has been shown not to hurt (core crop) or to help (everything else) on receipts that weren't used to tune it.

## In scope
1. **Measurement first.**
   - `scripts/eval-receipts.ts` and the pre-fill tool for `expected.json`.
   - A tuning / held-out split.
   - A headless-browser harness under `scripts/ocr-harness/` that runs **the same pipeline modules** the app runs.
2. **The staged pipeline** (`lib/scanPipeline/`).
   - Pure orchestration, stage interfaces, config and flags, plus the quality rule and retry.
   - All unit-tested with fake stages.
   - Web and native stage sets.
   - Native stages are identity stubs, so native behaviour is unchanged.
3. **Web stages:**
   - `locateDocument` and `cropAndFlatten` with OpenCV (core, D4);
   - `normalizeScale` on the crop, plus a second pass driven by text height;
   - `enhance` (grey + illumination flattening + optional CLAHE, **never binarize**);
   - `recognize` (Tesseract.js with the cheap parameter wins measured, plus strip tiling and zoom on doubt).
4. **Scan screen:** "Preparing photo…" and retry progress copy, and the failure screen. A `ui-ux-designer` pass.
5. **Docs:**
   - an ADR for the staged pipeline;
   - an ADR for OpenCV on web (main session to assign numbers: 0015 is free, so this spec asks for **0015 = pipeline** and **0016 = opencv.js on web**);
   - concept notes;
   - `docs/before-production.md`;
   - a receipt-eval skill update proposal.

## Out of scope (cut)
- **Native stage implementations.** VisionKit document camera, `VNDetectDocumentSegmentationRequest` + `CIPerspectiveCorrection`, ML Kit Document Scanner, and native enhance. All need the dev build; see § Notes for the native spec. Native gets stubs: `locate` → none, `crop` → identity, `enhance` → identity, `normalizeScale` → today's rule (identical result when there's no crop), `recognize` → today's `textRecognizer`.
- The native failure screen. It is flag-gated; whether it's on is open question Q6.
- A manual crop box on web (Q4).
- Learned dewarping, super-resolution and shadow-removal nets. They need a server and conflict with ADR 0010.
- Morphology, median or denoise filters, and unsharp masking on the OCR image.
- Any binarization of the OCR image.
- A confidence-based quality signal. Web gets optional line confidence, but C2 doesn't use it.
- Parser rule changes. Backlog item 2 is separate. The only parser change here is the read-only helper export in Task 13.
- A custom minimal OpenCV build, and prefetching OpenCV.

## Shared contracts (defined once; tasks point here)

### C1. Eval data, scoring and the decision rules
**Files** (gitignored `eval/receipts/`; photos also in gitignored `/receipts/`):
- `<name>.<variant>.ocr.json`, written by the harness:
  ```
  { version: 1, variant: string, photo: string,
    source: {width, height}, prepared: {width, height}[] /* per pass/strip */,
    lines: RecognizedLine[] /* the final lines the parser sees */,
    stages: { locate: { method: 'quad'|'mask'|'none', confidence: number, quad: [x,y][] | null },
              cropApplied: boolean, scale: number[] /* per pass */, enhance: string[],
              passes: number, tiles: number, zoomRereads: number, retried: boolean },
    meta: { medianLineHeight: number|null, meanLineConfidence: number|null, approximate?: true,
            timingsMs: { decode, cvLoad, locate, crop, normalize, enhance, ocr, total } } }
  ```
- `<name>.expected.json`, ground truth in **integer cents only**:
  ```
  { version: 1, status: "draft" | "checked", set: "tuning" | "heldout", setReason: "hash" | "used-before-split",
    photo: string, items: [{ name: string, qty: number, totalCents: number }],
    subtotalCents, taxCents, tipCents, feesCents: number|null,
    discounts: [{ label: string, cents: number, appliesTo: "subtotal"|"total" }], totalCents: number|null }
  ```
  - An item's `totalCents` is the line price including priced modifiers, the same as `ParsedItem.totalCents`.
  - The eval rejects a non-integer or negative cents value, a string amount, or a `qty` that isn't an integer ≥ 1. The message names the file and field, and nothing is coerced.
- **Name.** The slug of the photo's base name: lowercase, `[a-z0-9-]`, at most 60 characters. A second photo with the same slug gets `-2`.

**How the user provides ground truth:**
1. Put photos in `receipts/`. JPEG, PNG and WebP work. HEIC isn't decodable in Chromium, so the harness says so and skips it.
2. Run `npm run ocr:harness -- --variants current`.
3. Run `npx tsx scripts/eval-init.ts`. It writes `<name>.expected.json` for each photo that doesn't have one, **pre-filled from the current parse**, with `status: "draft"`. It never overwrites a file unless given `--force <name>`.
4. Correct the names, qtys and cents with the photo open, then set `status: "checked"`.
5. Only `checked` files are scored. Drafts are listed as "unchecked, skipped", so the parser is never graded against its own output.

**Split (D3):**
- `set` is assigned once by `eval-init` and never changed by any tool.
- A new photo gets its set from `SHA-256(name)`: first byte mod 5, with 0–2 → `tuning` and 3–4 → `heldout`. That gives roughly 60/40, and nobody chooses.
- Receipts already seen while building the parser, the upscale rule or this spec are forced to `tuning` with `setReason: "used-before-split"`. These are the four in `receipts/` today (`good-guy-…`, `miami-…el-chalan…`, `quantity2case`, `diff-quantity-size`) and any `eval/receipts/*.jpg` that already exists.

**`diff-quantity-size`** ("The Continent DC", 480×640, receipt ≈ 40% of a marble-table frame) motivates D4. It is tuning only, and no threshold may rest on it alone.
- Its expected file records `5 Cape Town Margarita` as qty 5 with `totalCents: 9000`, and `Service Charge (20.00%) $36.00` as `feesCents: 3600`.
- **No** item or total may come from the `3% ($6.48)` paragraph or the "Gratuity is included" text. How the parser handles that paragraph is a parser concern; this spec only measures it.
- Any fixture ever derived from its OCR has the server's name and card or check numbers stripped, as in `lib/fixtures/receipts.ts`.

**How many receipts:**
- A decision needs **at least 12 checked tuning and 8 checked held-out receipts (20 in total)**.
- **30 is recommended** (about 18 + 12), matching the plan's "30 real receipts".
- Cover these cases:
  - long receipts (40+ lines);
  - faded thermal paper;
  - shadows;
  - angled or perspective shots;
  - a receipt that is small in the frame;
  - a white or marble table;
  - crumpled paper;
  - dot-matrix print;
  - a low-resolution screenshot.
- Below the minimum the eval prints `INSUFFICIENT DATA: no decision`, and Task 14 can't change what ships.
- **The user needs to add about 16–26 more photos to `receipts/`** (Q1).

**Scoring** (`lib/receiptEval.ts`, pure):
- Names are normalised: lowercase, NFKD with diacritics stripped, alphanumerics only. Similarity is 1 − Levenshtein / max(len). A match needs **≥ 0.6** (starting value: "the same item with OCR typos").
- Matching is greedy and one-to-one: each expected item pairs with an unmatched parsed item that has **exactly equal `totalCents`** and similarity at or above the threshold, best first. An `exact` match also needs an equal qty. Both kinds are reported.
- Per receipt:
  - `matched`, `expected`, and `extra` (unmatched parsed items);
  - `reconciled`: `checkTotals(parsed)` has neither `items_vs_subtotal` nor `subtotal_vs_total`, using the parser's own `TOLERANCE_CENTS`, not a redefinition;
  - `totalCorrect`: parsed `totalCents` === expected.
- Per set, with tuning and held-out **separate and never pooled**:
  - line-item accuracy = Σmatched / Σexpected;
  - Σextra;
  - % reconciled;
  - % totalCorrect;
  - the 3 worst receipts by (expected − matched) + extra, with what was missed and what was extra.
- **Peeking guard.** Held-out numbers print only with `--confirm`. Otherwise the report says `held-out hidden (use --confirm once you've chosen on tuning)`.

**Decision rules (pure):**
- **`decide(baseline, candidate)`** is used for every optional stage or parameter. It returns ADOPT only if all of these hold:
  - on tuning:
    - (a) Σmatched rises by ≥ max(2, ⌈2% × Σexpected⌉), a noise guard (starting value);
    - (b) no receipt loses more than 1 matched item;
    - (c) Σextra rises by at most 1;
    - (d) the totalCorrect count doesn't fall;
  - then on held-out (`--confirm`):
    - (e) Σmatched doesn't fall;
    - (f) no receipt loses more than 1 matched item;
    - (g) the totalCorrect count doesn't fall.
  - Otherwise it returns REJECT, naming the failing clause.
  - Below the receipt minimum it returns NO DECISION.
- **`decideCore(baseline, candidate)`** is for the core locate + crop stages (D4). It is the same rule without (a): no gain is required, only no harm. A REJECT here goes to the user (Q2).
- **Held-out is run once per experiment.** A failure there rejects the candidate. It is never re-tuned on held-out.
- **Flow simulation** (`--flow <primary>,<retry>`) runs the pipeline's own retry logic over saved outputs: C2 on the primary, then on the retry if needed, then `pickBetter`. Task 14 uses it.

### C2. Quality rule (`lib/scanPipeline/assessQuality.ts`, pure; used by the pipeline on every platform and by the eval's `--flow`)
`assessQuality(text: RecognizedText, parsed: ParsedReceipt): { ok: boolean; problems: ScanProblem[]; gapCents: number }`

`ScanProblem` = `'no_items' | 'too_few_lines' | 'no_total' | 'items_vs_subtotal' | 'subtotal_vs_total'`. `ok` ⇔ there are no problems.

The problems:
- `no_items`: there are no items.
- `too_few_lines`: `text.lines.length < MIN_LINES`, with `MIN_LINES = 5` as the starting value. *Why it's general:* any itemised receipt has at least one item, a total and a header.
- `no_total`: `parsed.totalCents === null`.
- `items_vs_subtotal` / `subtotal_vs_total`: exactly when `checkTotals(parsed)` returns them. **The tolerance is the parser's `TOLERANCE_CENTS`, 1¢ per check, imported and not copied.**
- A missing subtotal on its own isn't a problem (A2.1's cross-check covers it).

`gapCents` = Σ|gap| over `totalsGaps(parsed)`.

`pickBetter(a, b)` decides by the first of these that differs:
1. ok beats not ok;
2. fewer problems;
3. smaller `gapCents`;
4. more items;
5. more lines;
6. if everything ties, keep `a`.

**Boundary cases that the pipeline tests and the eval tests both use:**
- A gap of exactly 1¢ → ok; 2¢ → not ok.
- 1¢ off on both checks → ok. Each check is ±1¢ on its own, the same as the form and the DB (M1b A3.2).
- 1¢ on one check and 2¢ on the other → not ok.
- 4 lines → `too_few_lines`; 5 lines → no problem.

### C3. Pipeline architecture (`lib/scanPipeline/`)
```
lib/scanPipeline/
  types.ts          stage interfaces + data types (below)
  config.ts         PipelineConfig per platform, VARIANTS, flags (pure data)
  run.ts            runScanPipeline(): pure orchestration over injected stages
  assessQuality.ts  C2
  textHeight.ts     median line height, rescale factor (pure)
  stripTiling.ts    cuts + merge (pure)
  zoomOnDoubt.ts    row selection + accept rule (pure)
  web/stages.ts     web StageSet (cv client + Tesseract); RN-free; lazily imported
  web/cvClient.ts   main-thread client for the OpenCV worker (C4)
  web/cv/*.ts       worker + OpenCV ops (locate, warp, resize, enhance, crop-row); take `cv` as a parameter
  native/stages.ts  native StageSet: identity stubs + today's prepare/recognize
lib/scanReceipt.ts / .web.ts / .native.ts   entry used by scan.tsx: builds the StageSet and calls runScanPipeline
```

**Stage interfaces** (`types.ts`). `Img` is an opaque, platform-owned handle: on web it's an image id held inside the worker, or a blob URL; on native it's a `file://` URI. Every stage takes `ctx: { signal?: AbortSignal; onStage?; onProgress? }`.
1. `locateDocument(img) → { method: 'quad'|'mask'|'os-scanner'|'none'; quad: [Pt,Pt,Pt,Pt] | null; confidence: number /*0–1*/ }`
2. `cropAndFlatten(img, loc, { marginFraction, minConfidence }) → Img`. This is the **identity** when `loc.confidence < minConfidence` or `loc.quad` is null.
3. `normalizeScale(img, { firstPass: { medianLineHeight } | null }) → { img, scale } | null`.
   - With `firstPass: null` it applies the image-size rule (`targetSize` + `RECOGNITION_MAX_EDGE` + `RECOGNITION_UPSCALE`) **to this image, which is the crop**. With an identity crop that's today's rule exactly.
   - With a first pass it returns null when the text height is already in band.
4. `enhance(img, EnhanceOptions) → Img`. Identity when `false`. **Never binarizes the OCR image.**
5. `recognize(img, RecognizeConfig) → { text: RecognizedText; medianLineHeight; meanLineConfidence }`. Strip tiling and zoom on doubt are sub-steps inside the web implementation, driven by config.
6. `assessQuality`: pure, not platform-specific (C2).
7. `dispose(img[])`: frees handles. Never throws.

**Orchestration** (`run.ts`, pure). It takes the input `Img`, a `StageSet` and a `PipelineConfig`, and returns `{ best: { text, parsed, verdict }, attempts, trace }`:
```
attempt(variant):
  loc   = locateDocument(img)                     // skipped (method 'none') if config.locate === false
  crop  = cropAndFlatten(img, loc, config.crop)    // identity below minConfidence
  s1    = normalizeScale(crop, { firstPass: null })
  enh   = enhance(s1.img, config.enhance)
  r1    = recognize(enh, config.recognize)
  if config.textHeightRescale: s2 = normalizeScale(crop, { firstPass: r1 }); if s2: enhance + recognize again; keep pickBetter
  parsed = parseReceipt(text); verdict = assessQuality(text, parsed)
primary = attempt(config.primary)
if !primary.ok && config.retry: retry = attempt(config.retry); best = pickBetter(primary, retry)
```
- Stage outputs from the primary may be reused by the retry when the variants share a prefix (for example the same crop). That's an optimisation the implementer may add; it isn't required.
- `dispose` runs for every handle in `finally`.
- A stage that throws `StageUnavailable` (for example OpenCV failing to load) makes that stage the identity for the rest of the scan and is recorded in `trace`. **It never fails the scan.**
- Any other error rejects with the existing `RecognitionError` codes.

**Config** (`config.ts`, pure data; the only place the app, the harness and the eval read variants from):
```
type PipelineConfig = { locate: boolean; crop: { marginFraction: number; minConfidence: number } | false;
  enhance: false | { gray: boolean; flatten: false | { kernelLineHeights: number }; clahe: false | { clipLimit: number; tile: number } };
  textHeightRescale: false | { targetLineHeightPx: number; band: [number, number] };
  recognize: { tesseract?: { params: Record<string,string>; init?: Record<string,string>; rotateAuto?: boolean };
               output?: 'png'|'jpeg90'; tiling: false | TilingOptions; zoomOnDoubt: false | ZoomOptions } };
export const VARIANTS: Record<string, { platform: 'web'|'native'; config: PipelineConfig }>;
export const PIPELINE: { web: { primary: string; retry: string | null }, native: { primary: string; retry: string | null } };
export const WEB_CV_PREPROCESS: boolean;     // master switch: false ⇒ web locate/crop/cv-normalize/enhance are identity and OpenCV is never fetched
export const SHOW_FAILURE_SCREEN: { web: boolean; native: boolean };
```
- **Starting values keep today's behaviour:** `PIPELINE.web = { primary: 'web-current', retry: null }`, `PIPELINE.native = { primary: 'native-current', retry: null }`, `WEB_CV_PREPROCESS = false`, `SHOW_FAILURE_SCREEN = { web: true, native: <Q6> }`.
- `web-current` means: no locate or crop, normalize via today's `prepareForRecognition` (expo-image-manipulator), no enhance, today's `TESSERACT_PARAMS`.
- Only Task 14 changes `PIPELINE` and `WEB_CV_PREPROCESS`, and only from results.
- Every numeric constant carries a `Why:` comment (the general reason) and a `Tuned:` comment (the tuning result and date, plus the held-out result).

### C4. OpenCV worker protocol (`lib/scanPipeline/web/cv/protocol.ts`, types only)
The worker holds images by id so stages don't re-encode between steps.

Main → worker:
- `load(id, bitmap /* transferred */, maxDecodeEdge)`
- `locate(id)` → loc
- `warp(id, quad, marginFraction)` → newId
- `resize(id, w, h)` → newId
- `enhance(id, opts)` → newId
- `encode(id, 'png'|'jpeg90')` → Blob
- `cropRow(id, rect, scale)` → Blob
- `rowInk(id)` → Uint32Array
- `free(ids)`

Worker → main:
- `ready`;
- `result`;
- `error { code: 'load_failed' | 'process_failed' }`. The code is the only thing sent; no library text.

Rules:
- No message carries recognised text or a filename.
- The worker frees every `Mat` in a `finally`.
- The client terminates the worker on abort, on error, at the end of the scan, and if `ready` doesn't arrive within `CV_LOAD_TIMEOUT_MS = 30000` (starting value).
- The client revokes every blob URL it creates.

## Tasks
Order: measurement → pipeline skeleton (no behaviour change) → harness → cheap Tesseract → OpenCV plumbing → **locate/crop (core)** → size on the crop → enhance → screen → smart chunk → what ships → docs.

Every experiment task follows the same routine:
1. Build its variant in `VARIANTS`.
2. Run it on **tuning** against the current best (a cumulative baseline).
3. Run `--confirm` once.
4. Append a row to § Results log.

A rejected variant stays in `VARIANTS`, but `PIPELINE` never references it. "Agent" is the agent file to follow. Line counts are rough.

### Task 1: Eval core and ground-truth tooling (agent: `implementer`, ~280 lines)
Files:
- `lib/receiptEval.ts` + `.test.ts`: normalise, similarity, match, scores, `decide`, `decideCore`, `assignSet`, validation. Pure.
- `scripts/eval-receipts.ts`, with flags `--variant`, `--compare a,b`, `--flow p,r`, `--only`, `--confirm`.
- `scripts/eval-init.ts`.
- `package.json`: add `tsx` (`npm i -E`) and `"eval": "tsx scripts/eval-receipts.ts"`.

This implements C1. `--flow` waits for Task 2 and says so until then.

### Task 2: Pipeline types and quality rule (agent: `implementer`, ~220 lines)
Files: `lib/scanPipeline/types.ts`, `lib/scanPipeline/assessQuality.ts` + test, and `scripts/eval-receipts.ts` (turns `--flow` on). This implements C2 and the C3 interfaces.

### Task 3: Orchestration, config and platform entry, with no behaviour change (agent: `implementer`, ~300 lines)
Files:
- `lib/scanPipeline/run.ts` + test (fake stages);
- `lib/scanPipeline/config.ts`;
- `lib/scanPipeline/native/stages.ts`;
- `lib/scanPipeline/web/stages.ts` (today's web behaviour only: normalize via an injected `prepareForRecognition`, recognize via `lib/webOcrEngine.ts`; must not import `react-native` or `expo-*`);
- `lib/scanReceipt.ts` / `.web.ts` / `.native.ts`;
- `app/(app)/scan.tsx` (calls `scanReceipt`; same screens as today);
- `lib/textRecognition.ts` (adds the `'preparing' | 'retrying'` stage types).

Requirements:
- Web loads `web/stages.ts` with `import()`, the same discipline as `engineLoader`.
- Web starts **one Tesseract worker per scan**, reused across all passes and terminated in `finally`.
- Endings, each tested: success; an error in any stage; cancel in each stage; a newer scan replacing an old one; `StageUnavailable`. Every one terminates the workers, revokes the blob URLs and re-enables the UI.

### Task 4: Browser harness running the exact web pipeline; E0 (agent: `native-mobile`, ~300 lines)
Files:
- `scripts/ocr-harness/run.ts` (Node, Playwright);
- `server.ts` (`127.0.0.1` only, random port; serves `public/`, the bundle, and the photos read-only from `receipts/` and `eval/receipts/`);
- `page.ts` (browser; imports `lib/scanPipeline/run.ts`, `lib/scanPipeline/web/stages.ts`, `lib/scanPipeline/config.ts`);
- `prepare-current.ts`;
- `shims/expo-modules-core.ts`;
- `package.json`: `playwright` and `esbuild` (exact pins), plus `"ocr:harness": "tsx scripts/ocr-harness/run.ts"`.

How it reproduces today's path:
- `prepare-current.ts` reproduces `lib/prepareImage.web.ts` with **expo-image-manipulator's own web source**: `src/web/utils.web.ts#loadImageAsync`, `src/web/actions/ResizeAction.web.ts` (Hermite resample), then `toBlob('image/jpeg', RECOGNITION_JPEG_COMPRESS)`.
- `expo-modules-core` is aliased to a shim that exports `CodedError`. *(Verify it bundles. If it doesn't, mark the outputs `meta.approximate` and ask the main session.)*

Flags: `--variants`, `--only`, `--browser chromium|webkit` (default chromium) *(verify that Playwright WebKit runs on this macOS)*, and `--dump-binary` (writes Tesseract's `imageBinary` to `eval/receipts/<name>.<variant>.binary.png`; harness only).

Guards and the first run:
- The harness blocks every request whose host isn't `127.0.0.1`, and fails the run if one happens.
- It writes only to `eval/receipts/`.
- **E0:** run `web-current` twice on every photo.

### Task 5: Tesseract knobs; E1 and E4 (agent: `implementer`, ~220 lines)
Files: `lib/webOcrEngine.ts` + test, `lib/receiptTypes.ts`, `lib/scanPipeline/web/stages.ts`, `lib/scanPipeline/config.ts`.
- `startWorker(onLog, onError, init?)` passes `init` as the `createWorker` config. Dictionary settings are init-only *(verify in `node_modules/tesseract.js/src/worker-script/index.js`)*.
- `readLines(worker, uri, tesseractConfig)` calls `setParameters(params)` and passes `{ rotateAuto }` (typed at `index.d.ts:94`).
- `RecognizedLine` gains an optional `confidence?: number` (0–100). Native leaves it undefined, and the parser ignores it.
- Variants:
  - E1: `thresholding_method` 0, 1 or 2, crossed with `user_defined_dpi` unset or 300;
  - E4: `rotateAuto` on, dictionaries off.

### Task 6: OpenCV plumbing, worker and cv resize; E-cv0 (agent: `native-mobile`, ~300 lines)
Files:
- `package.json`: `@techstark/opencv-js@4.12.0-release.1`, exact pin.
- `scripts/copy-opencv-assets.mjs` (same pattern as the Tesseract script).
- `scripts/build-cv-worker.mjs` (esbuild), with both added to the `prestart`, `preweb` and `preexport:web` hooks.
- `.gitignore`: `/public/opencv/`.
- `lib/scanPipeline/web/cv/{protocol,worker,resize}.ts` + tests.
- `lib/scanPipeline/web/cvClient.ts` + test (fake Worker).
- `web/stages.ts`: the cv `normalizeScale`.

Details:
- Decode with `createImageBitmap(blob, { imageOrientation: 'from-image' })` *(verify the EXIF behaviour in Chromium and WebKit)*, capped at `maxDecodeEdge = 4096`. That's a starting value, set as a memory guard: one 4096² RGBA image is about 64 MB.
- cv resize uses the same `targetSize` semantics, with `INTER_AREA` going down and `INTER_CUBIC` going up.
- Variants, one factor each:
  - `cv-resize-jpeg` vs `web-current` isolates the resampler;
  - `cv-resize-png` vs the winner isolates JPEG ringing.
- Jest loads the real OpenCV in `web/cv/*.test.ts` *(verify it initialises under `jest-expo`; if not, use `scripts/test-cv.ts` with `tsx` + `node:test`, add `"test:cv"`, and report it)*.

### Task 7: `locateDocument` + `cropAndFlatten` on web, the core stage; E5 (agent: `native-mobile`, ~300 lines)
Files: `lib/scanPipeline/web/cv/locate.ts` + test, `lib/scanPipeline/web/cv/warp.ts` + test, `web/stages.ts`, `config.ts`.

**1. Quad path.** It runs on a copy at most 800 px on the long edge (starting value). The steps are grey → Gaussian blur → Canny → dilate → `findContours` → the largest contours → `approxPolyDP` at ε = 2% of the perimeter → a convex 4-gon.

The 4-gon is accepted only if all of these hold (starting values):
- its area is ≥ 15% of the image;
- every interior angle is within 90° ± 35°;
- it touches at most 2 image edges.

Confidence = clamp((edge-gradient ratio − 1) / 2, 0, 1), where the ratio is the mean gradient along the quad's edges divided by the image's mean gradient.

**2. Mask fallback** (no acceptable quad). Receipts are bright, low-saturation paper on a darker or more colourful background.
- Build a mask in HSV: V ≥ the Otsu threshold of V, and S ≤ 60 (starting value).
- Close it morphologically and take the largest connected component, then its `minAreaRect`.
- The component's area must be ≥ 15% of the image, it must fill its rectangle by ≥ 0.85, and it must touch ≤ 2 edges.
- Confidence = clamp(the mean V contrast between the inside and a band just outside, ÷ 60, 0, 1) × the fill ratio.
- This threshold is applied to a **geometry mask only** and never to the OCR image.

**3. Neither path accepted:** `{ method: 'none', confidence: 0 }`. A bright receipt on a bright marble table can end up here. That's honest, and the crop then keeps the full image.

**4. Warp.** A perspective transform at **full decoded resolution**, sized from the quad's edge lengths, then a margin of `max(10 px, marginFraction × the crop's short side)` with `marginFraction = 0.025` (starting value, "about 2–3%"), padded with the median border colour. *Why it's general:* tessdoc asks for about a 10 px border; a tight crop or a big background both hurt. `minConfidence = 0.5` (starting value).

Variants:
- `web-crop` = cv-normalize winner + locate + crop, judged by **`decideCore`**;
- PSM 4 re-tried after the crop (the E4 leftover).

jscanify isn't used: it wraps the same calls, and its npm `main` pulls in `jsdom` + `canvas`.

### Task 8: `normalizeScale` on the crop + a text-height second pass; E2 (agent: `implementer`, ~200 lines)
Files: `lib/scanPipeline/textHeight.ts` + test, `run.ts` (the second-pass branch), `web/stages.ts`, `config.ts`.
- `medianLineHeight(text)` = the median `box.height` over lines that have boxes. Every engine returns boxes, so this works for all platforms. The result is null with fewer than 3 boxed lines.
- `rescaleFactor(median, { targetLineHeightPx, band })` returns null inside the band, or when the median is null, ≤ 0 or non-finite. Otherwise it returns target / median, clamped to [0.5, 3].
- The second pass resizes the **crop** (not the first-pass image), so quality isn't lost twice. It's still capped by `RECOGNITION_MAX_EDGE`.
- Starting targets: 28, 34, 40 and 46 px, roughly capitals of 20, 25, 30 and 35 px *(the ratio is an assumption; correct it from `--dump-binary` evidence)*. Band ±15%.
- *Why it's general:* Tesseract's error tracks glyph height in pixels (report § "Character height").
- The first-pass size rule is the image-size rule applied to the crop. With the crop on, D4's "a small receipt in a big frame stays small" case is fixed by the crop plus this rule, with no special case.

### Task 9: `enhance` on web; E3 (agent: `native-mobile`, ~200 lines)
Files: `lib/scanPipeline/web/cv/enhance.ts` + test, `web/stages.ts`, `config.ts`.
- `toGray` (luma).
- `flattenBackground`: grey ÷ a morphological closing or large blur of grey, rescaled to 0–255. The kernel is `kernelLineHeights` × the line height estimated from the image's projection profile (starting value 4), never a fixed pixel size.
- `clahe(clipLimit 2, tile 8)` (starting values).
- The output is 8-bit grey with intermediate levels.
- Variants, one factor each: `+gray`, then `+flatten`, then `+clahe`. CLAHE must beat flatten alone.

### Task 10: Scan screen, progress and failure screen (agent: `implementer`, then a **`ui-ux-designer` skill pass** before review, ~250 lines)
Files: `app/(app)/scan.tsx`, `__tests__/scan.test.tsx`.

Copy (starting wording; the designer may tighten it, and the user sees the final text):
- `preparing`: "Preparing photo…". On the first OpenCV fetch on this device: "Preparing photo… The first time takes a little longer."
- `retrying`: "Taking a closer look…"
- The other stages keep today's copy.

**Failure screen** (when `!best.verdict.ok` and `SHOW_FAILURE_SCREEN[platform]`):
- the header "Scan receipt";
- a warning banner, "We couldn't read this receipt clearly.";
- one allow-listed line chosen by the first problem:
  - "We found no items." for `no_items` or `too_few_lines`;
  - "We couldn't find the total." for `no_total`;
  - "The items don't add up to the total." for a gap;
- the tip "Lay it flat in good light and fill the frame.";
- primary button **"Retake photo"**: clears the scan result and starts capture;
- secondary button **"Type it in"**: `setScanResult(best.parsed)`, then `/bill`, pre-filled;
- labels and hints on both buttons;
- no library text anywhere.

When the result is ok, the screen behaves as today.

### Task 11: Wire the retry (agent: `implementer`, ~80 lines)
Files: `config.ts` and tests. Make sure `PIPELINE.web.retry` can name any web variant. Then use `--flow` on the tuning set to report which retry rescues the most primary failures. Changing what ships waits for Task 14.

### Task 12: Strip tiling for tall receipts; E8 (agent: `native-mobile`, ~280 lines)
Files: `lib/scanPipeline/stripTiling.ts` + test (pure), `web/cv/worker.ts` (`rowInk`), `web/stages.ts`, `config.ts`.

**Trigger** (starting values): on the crop, height / width ≥ 2.5 **and** a long edge > 1.25 × `RECOGNITION_MAX_EDGE`, meaning the cap would shrink the text by more than 20%.

**Cuts:**
- `rowInk[y]` counts the pixels darker than (the median of the row band − 40) on the enhanced grey image, or on plain grey.
- A row is blank when its ink is ≤ 0.2% of the width.
- `findCuts(rowInk, targetStripPx = RECOGNITION_MAX_EDGE, window ±25%)` picks the centre of the longest blank run in each window.
- If any window has **no blank run, there's no tiling at all**. A cut through text is never allowed.
- At most `MAX_STRIPS = 6`.

**Strips:**
- Each strip is read at native resolution. Its width is scaled down only if it's wider than the cap.
- Overlap is 1 × the median line pitch above and below.

**Merge:**
- `mergeStripLines` maps boxes back to the coordinates of the untiled crop.
- A line from strip k+1 whose centre is in the overlap is dropped if a line in strip k has similarity ≥ 0.8 (the C1 similarity) and lies within 0.5 pitch. The higher-confidence copy is kept.
- The output is ordered top to bottom.

Progress is reported per strip. The bar shows the overall fraction.

### Task 13: Zoom on doubt; E9 (agent: `implementer`, ~260 lines)
Files: `lib/scanPipeline/zoomOnDoubt.ts` + test (pure), `lib/receiptText.ts` (export a read-only `hasPriceToken(text)` that reuses the existing money-token regex; no behaviour change), `web/cv/worker.ts` (`cropRow`), `web/stages.ts`, `config.ts`.
- **Which rows.** `selectDoubtfulRows` looks only in the item region, from the first line with a price token to the line holding the total. A line qualifies if it has no 2-dp price token, **or** its confidence is < 60 (starting value), **or** it belongs to a `qty_price_mismatch` item. Candidates are ordered by ascending confidence, with at most `MAX_ZOOM_ROWS = 8` (starting value).
- **Re-read.** Crop the box from the image that pass saw, with a margin of `max(10 px, 0.3 × box height)`, and scale it to the Task 8 target (else 40 px) with `INTER_CUBIC`. Read it with `tessedit_pageseg_mode = 7`, set on the shared worker and restored afterwards.
- **Accept.** `acceptZoomRead(old, new)` accepts only if all hold:
  - the new confidence is ≥ the old + 5 (starting value);
  - a price is never lost;
  - a row that had no price gains exactly one price token.
- **After.** Re-parse, re-assess, and keep `pickBetter(before, after)`.

### Task 14: Choose what ships (agent: `implementer`, ~60 lines; **gated on Q1 and Q2**)
Files: `config.ts`, § Results log.
- Pick `PIPELINE.web` and `WEB_CV_PREPROCESS` from `decide` / `decideCore` results and `--flow` on tuning, then `--confirm` once.
- If nothing passes, today's values stay and the result goes to the user.

### Task 15: Docs (agent: `docs-writer`; runs after Task 14)
Files:
- `docs/learning/decisions/0015-staged-scan-pipeline.md`: the six stages, the interfaces, per-platform implementations, stubs, flags, measured shipping;
- `docs/learning/decisions/0016-opencv-on-web.md`: the build table above, self-hosting, the worker, lazy loading, sizes, results;
- the README rows for both (numbers as assigned by the main session);
- new `docs/learning/concepts/scan-pipeline.md`: stages, why geometry and scale come before filters, why no binarization, why zooming adds no pixel information, tuning vs held-out and overfitting;
- updates to `docs/learning/concepts/on-device-ocr.md` and `testing-strategy.md`;
- a dated note in ADR 0012 Decision 3;
- `docs/before-production.md` items:
  - `opencv.js` size, hosting, cache headers and content type;
  - `public/opencv/` copied into native exports;
  - the custom minimal OpenCV build;
  - the copy and worker-build scripts in the production build;
  - the harness is Chromium/WebKit, not real iPhone Safari;
  - low-end phone memory with the 4096 decode;
- a status line on `docs/backlog.md` item 3;
- `docs/lessons/proposals/2026-11-22-receipt-eval-skill-update.md` (the new flags, the split, `eval-init`, the harness; `.claude/` isn't edited directly).

## Acceptance criteria
QA runs all of these without a phone. Commands run from the repo root. Agents never read or write `.env*`; pass `EXPO_PUBLIC_*` values inline. Jest runs as `npm test -- --maxWorkers=4`.

**General**
1. `npm run typecheck` passes. `npm test -- --maxWorkers=4` passes, and so does `npm run test:cv` if Task 6 created it.
2. The new pins (`@techstark/opencv-js`, `tsx`, `esbuild`, `playwright`) have no `^` or `~`.
3. New code has no `any` without a comment, and no console calls: `grep -rnE "\bconsole\.(log|warn|error|info|debug)\(" lib/scanPipeline lib/scanReceipt*.ts lib/receiptEval.ts` prints nothing. Today this errors because the paths don't exist yet. Shown to work: the same pattern matches `scripts/copy-tesseract-assets.mjs`.

**Measurement (Tasks 1, 4)**
4. `eval-init` writes `status: "draft"` files for every photo that has a `web-current` ocr.json and no expected file. A second run changes nothing (mtimes are unchanged). Only `--force <name>` overwrites.
5. The four current photos get `tuning` / `used-before-split`. A unit test fixes the hash-assigned set for 5 sample names.
6. An expected file with `12.5`, `-1`, `"12.50"` or `qty: 0` is rejected with the file and field named, and nothing from it is scored.
7. Scoring tests cover:
   - an exact match;
   - an OCR-typo name (≥ 0.6) matches, and a different same-price item (< 0.6) doesn't;
   - a 1¢-different price doesn't match;
   - duplicate items each match once;
   - junk counts as `extra`;
   - `reconciled` uses `checkTotals` (the 1¢ and 2¢ cases).
8. Drafts are skipped and listed. With no checked files the eval says so and exits 0.
9. Without `--confirm` no held-out numbers print, and the hidden line does. With it, tuning and held-out print separately and are never pooled.
10. `decide` tests: each clause (a)–(g) failing alone, the noise guard exactly at the threshold (ADOPT) and one below it (REJECT), and NO DECISION below 12/8. `decideCore` tests: equal numbers → ADOPT; one held-out receipt losing 2 items → REJECT.
11. `npm run ocr:harness -- --variants web-current --only <name>` writes a C1-shaped file, and `git check-ignore` reports it as ignored.
12. The harness page imports the app's `lib/scanPipeline/run.ts` and `web/stages.ts`. `grep -rn "createWorker(" scripts/ocr-harness` prints nothing. Shown to work: it matches `lib/webOcrEngine.ts`.
13. Running E0 twice gives byte-identical `lines` for every photo.
14. **Privacy:** during a harness run, no request goes to any host other than `127.0.0.1`. The harness exits non-zero if one is attempted. QA shows the guard with a dummy external fetch in a scratch copy of the page script, never in the repo, or marks it NOT SHOWN TO FAIL. Nothing is written outside `eval/receipts/`, and photos are never copied.
15. `grep -rnE "from ['\"](react-native|expo)" lib/scanPipeline` prints nothing: the pipeline is RN-free. (The injected `prepareForRecognition` comes from `lib/scanReceipt.web.ts`.)

**Pipeline (Tasks 2–3), C2 boundary cases**
16. `assessQuality` gives:
   - exactly 1¢ → ok;
   - 2¢ → the matching gap problem;
   - 1¢ on both checks → ok;
   - 1¢ + 2¢ → not ok;
   - 0 items → `no_items`;
   - 4 lines → `too_few_lines` and 5 → no such problem;
   - no total → `no_total`;
   - a missing subtotal alone with items + extras = total → ok.
17. `assessQuality` imports the parser's tolerance and defines none of its own (`grep -nE "TOLERANCE|= 1\b" lib/scanPipeline/assessQuality.ts` shows only the import). It agrees with `checkTotals` on every `lib/fixtures/receipts.ts` case.
18. `pickBetter`: each ordering step decides one test, and a full tie returns the first argument.
19. `run.ts` tests with fake stages check:
   - stage order (locate → crop → normalize → enhance → recognize → assess);
   - `cropAndFlatten` is the identity below `minConfidence` and at `confidence = minConfidence − 0.01`, and applies at exactly `minConfidence`;
   - `normalizeScale` receives the **crop**, not the input image;
   - primary ok → no retry;
   - primary not ok, retry better → the retry wins;
   - retry worse → the primary is kept;
   - `retry: null` → one attempt;
   - `StageUnavailable` in locate → the scan completes with the full image, and `trace` records it;
   - `dispose` is called for every handle on success, error and abort.
20. With `WEB_CV_PREPROCESS = false`, a web run never calls the cv client (spy) and never creates a Worker for OpenCV.
21. **No behaviour change at the starting config:**
   - Web: the stages call `prepareForRecognition` and `recognize` with the same arguments as today's `scan.tsx`.
   - Native (Platform ios): `native/stages.ts` makes the same prepare → recognize → parse calls as today, with `attempts: 1`.
   - All existing scan tests pass unchanged, apart from the new import path.
22. One Tesseract worker per web scan: in a scan with a retry and a second pass, `startWorker` is called once and `terminate` once.
23. Endings: cancel during `preparing`, `loading_engine`, `recognizing` and `retrying`, plus the cv timeout, each terminate every worker, revoke every created blob URL, and return the screen to idle. A timeout that already has a result shows that result's screen instead.

**Tesseract knobs (Task 5)**
24. Fake-worker test: the variant's params go to `setParameters`, `rotateAuto` goes to recognize, and `init` goes to `createWorker`. The `web-current` calls equal today's (PSM 6, `preserve_interword_spaces=1`, no init).
25. `mapTesseractResult` keeps today's output on the existing fixtures, and adds `confidence` only when it's a finite number between 0 and 100.
26. § Results log has E1 and E4 rows.

**OpenCV loading and bundles (Task 6)**
27. After `npm run export:web` (env inline), `dist/opencv/opencv.js`, `dist/opencv/LICENSE` and `dist/opencv/receipt-cv-worker.js` exist, and `git check-ignore public/opencv/opencv.js` reports it as ignored.
28. **The web entry bundle has no OpenCV code or worker reference:** `grep -lE "receipt-cv-worker|getBuildInformation" dist/_expo/static/js/web/entry-*.js` prints nothing. Shown to work: `grep -rlE "receipt-cv-worker" dist/_expo/static/js/web/` lists exactly one non-entry chunk, and `grep -c getBuildInformation dist/opencv/opencv.js` is ≥ 1. *(Verify the symbol exists in 4.12. If it doesn't, choose another exported name and reword.)*
29. **Metro never bundles OpenCV:** `grep -rl getBuildInformation dist/_expo/static/js/` prints nothing.
30. **No native JS bundle contains the web stages or OpenCV.** After `npx expo export -p ios --output-dir <scratch>/ios` (and the same for android), `grep -rlaE "receipt-cv-worker|getBuildInformation|cvClient" <scratch>/ios/_expo/static/js <scratch>/ios/metadata.json` prints nothing. The static `public/opencv/` files are copied into native exports, as `public/tesseract/` is today; that's a before-production item, not a failure. *(Verify the native output layout; reword if it differs.)*
31. `grep -rn "@techstark/opencv-js" app components lib --include=*.ts --include=*.tsx` lists only files under `lib/scanPipeline/web/cv/` (type-only imports). Today it prints nothing.
32. **Manual check** in desktop Chrome, signed in with local Supabase, with a cv variant as primary (a scratch change that isn't committed, or after Task 14 if one ships). DevTools → Network shows:
   - `opencv.js` and the worker load from the same origin;
   - neither loads before a scan starts;
   - no third-party host is contacted.
33. `cvClient` tests with a fake Worker:
   - ready → result resolves;
   - `error` → rejects with its code;
   - no `ready` within `CV_LOAD_TIMEOUT_MS` (fake timers) → `terminate()` and `StageUnavailable`;
   - abort before ready → `terminate()` and `cancelled`;
   - every created blob URL is revoked.
34. With a fake `cv` that counts Mat create and delete, every worker op frees exactly what it allocates, both on success and when a step throws.

**Locate, crop and size on the crop (Tasks 7–8)**
35. **Quad case.** `locate` on a synthetic 1200×1600 dark background (V ≈ 70) with a light (V ≈ 230) quad rotated 12° with perspective skew returns `method: 'quad'`, confidence ≥ 0.8, and corners within 2% of the diagonal.
36. **Mask fallback.** For a synthetic light blob with rounded corners (so `approxPolyDP` gives more than 4 points) on a darker, coloured background: `method: 'mask'`, confidence ≥ 0.5, and `minAreaRect` corners within 3% of the diagonal.
37. **Nothing found.** A uniform image, light-on-light (V 220 on V 210), and a receipt covering 8% of the frame each return confidence < 0.5. The crop is then the identity (`stages.cropApplied === false`).
38. **The warp margin** is at least `max(10, 0.025 × short side)` px on every side (synthetic test).
39. **D4 size-on-crop.** For a synthetic 480×640 frame where a receipt quad covers about 40% of the area, the image passed to `recognize` has the long edge `targetSize(cropW, cropH, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE)` gives for the crop, and the receipt's pixels per text row are higher than with today's whole-image rule (the test computes both). Without a crop (identity), the size equals today's rule on the whole image.
40. `textHeight` tests:
   - in the band → null, and exactly at the band edge → null;
   - just outside → a factor;
   - clamped to 0.5 and 3;
   - null, 0, negative and NaN → null;
   - fewer than 3 boxed lines → null.
   The second pass resizes the crop, not the first-pass image (spy).
41. § Results log has E-cv0, E5 (judged by `decideCore`, with the share of tuning receipts where `cropApplied` was true), E2 and the PSM 4 re-check.

**Enhance (Task 9)**
42. `flattenBackground` on a synthetic left-to-right grey gradient from 120 to 240, with dark 3-px strokes, cuts the background's standard deviation by ≥ 50%, and the strokes stay darker than the background everywhere.
43. **No binarization of the OCR image.** Every shipped enhance setting yields more than 16 grey levels on the synthetic image and on one harness output (in `meta`). `grep -rnE "cv\.(threshold|adaptiveThreshold)\(" lib/scanPipeline/web/cv --exclude=locate.ts` prints nothing; `locate.ts` uses a threshold for the geometry mask only.
44. § Results log has E3 rows: gray, then flatten, then CLAHE, each against the previous best. CLAHE is adopted only if it beats flatten alone.
45. Each Results-log row records the median `timingsMs` per stage and in total (Chromium on this Mac). A variant whose median added time, excluding `cvLoad`, is > 4000 ms over its baseline is marked "too slow" and isn't shipped unless the user says otherwise (starting budget).

**Screen (Task 10)**
46. On web, `preparing` shows "Preparing photo…", the first cv load shows the longer line, and `retrying` shows "Taking a closer look…", all in a polite live region.
47. With a result that isn't ok, the banner shows the allow-listed line for each problem kind.
48. "Retake photo" clears the scan result and starts capture.
49. "Type it in" stores `best.parsed`, goes to `/bill`, and the form shows the read items.
50. Both buttons have an `accessibilityLabel` and an `accessibilityHint`.
51. An error whose message is "SECRET-LIB-TEXT" never renders.
52. With `SHOW_FAILURE_SCREEN.native = false` (or whatever Q6 decides), a native result that isn't ok behaves exactly as today, going to `/bill` when lines were found. This is tested for Platform ios.
53. Sign-out clears the scan result (the existing test passes), and a scan that finishes after sign-out stores nothing.
54. The task report records the `ui-ux-designer` pass and the final copy.

**Smart chunk (Tasks 12–13)**
55. `findCuts`:
   - cuts land only on rows with ink at or below the threshold;
   - a window with no blank run → null (no tiling);
   - more than `MAX_STRIPS` strips → null;
   - a short image → no cuts;
   - a fixed-seed property test over 200 random profiles never returns a cut on an inked row.
56. `mergeStripLines`:
   - a line duplicated in the overlap appears once, keeping the higher confidence;
   - equal text far apart is kept twice;
   - boxes come back in crop coordinates;
   - lines are ordered top to bottom.
57. Tiling triggers only when both conditions hold, and `stages.tiles` and `prepared` list one entry per strip.
58. `selectDoubtfulRows` picks only qualifying item-region rows, in confidence order, at most `MAX_ZOOM_ROWS`.
59. `acceptZoomRead`:
   - rejects a higher-confidence read that loses a price;
   - rejects a gain below +5;
   - accepts a priceless row that gains exactly one price at +5;
   - rejects two price tokens.
60. When zoom produces a worse parse, the original is kept (`pickBetter`).
61. `hasPriceToken` is a pure export, and every existing `lib/receiptText.test.ts` case passes unchanged.
62. § Results log has E8 and E9 rows with verdicts, timings, and the extra Tesseract calls per receipt (median and max). A step ships only with ADOPT and when the median total scan time is ≤ 25 s per receipt in the harness (starting budget).

**What ships (Task 14)**
63. `PIPELINE.web` and `WEB_CV_PREPROCESS` reference only variants with a held-out-confirmed ADOPT (or `decideCore` ADOPT for crop). Otherwise they stay at today's values, with a Results-log line saying why.
64. The `--flow` result for the shipped primary/retry pair is logged for tuning and held-out, with line-item accuracy stated against ADR 0010's 85%.

**Generality (D3)**
70. Every new rule or threshold has at least one unit test whose input is **synthetic or hand-made, not copied from `lib/fixtures/receipts.ts` or any receipt's OCR output**. That covers `MIN_LINES`, the similarity threshold, the decide guards, `minConfidence`, the quad and mask acceptance values, `marginFraction`, the rescale band, the flatten kernel, the cut threshold, `MAX_STRIPS`, the zoom margin and `MAX_ZOOM_ROWS`. The reviewer checks one per constant.
71. Every such constant has a `Why:` comment giving the general reason, and tuned constants also have a `Tuned:` comment (the tuning result, plus held-out, or "not adopted").
72. No receipt-specific code: `grep -rniE "chalan|caba[nñ]a|raintree|good ?guy|miami|quantity2case|continent|diff-quantity" lib app components --include=*.ts --include=*.tsx --exclude=*.test.ts --exclude-dir=fixtures` prints only today's two comment lines, `lib/receiptText.ts:87` and `lib/receiptText.ts:210` (checked on the current tree 2026-11-22).
73. Every ADOPT in § Results log has held-out numbers next to it and one recorded `--confirm` date. No row was re-tuned after its held-out run.

## Results log
Appended by Tasks 4–14. Columns: date | experiment | baseline → candidate | tuning Σmatched/Σexpected, Σextra, reconciled %, totalCorrect % | held-out (same) | verdict + clause | median stage ms / total ms | notes.

Task 5 rows (Chromium 159, 8 photos, one run each). Only 1 tuning receipt (`diff-quantity-size`) and 1 held-out receipt are `checked: yes`, so every verdict is PROVISIONAL and nothing was run with `--confirm`. The spec says no threshold may rest on `diff-quantity-size` alone. Median ms are over all 8 photos (ocr / total); web-current is 1082 / 1157.

| date | experiment | baseline → candidate | tuning | held-out | verdict | median ms ocr / total | notes |
|---|---|---|---|---|---|---|---|
| 2026-11-23 | E1 | web-current → web-tess-thresh0 | 0/5, extra 2, rec 0%, total 100% (same as baseline) | not run | REJECT (a) | 1063 / 1252 | Lines byte-identical on all 8 photos: explicit Otsu = the default, so the per-read parameter path itself changes nothing |
| 2026-11-23 | E1 | web-current → web-tess-dpi300 | 0/5, extra 2, rec 0%, total 100% | not run | REJECT (a) | 1117 / 1177 | Byte-identical on all 8: with global Otsu nothing reads the DPI. It does take effect with methods 1 and 2 (next rows) |
| 2026-11-23 | E1 | web-current → web-tess-thresh1 | 1/5, extra 2, rec 0%, total 0% | not run | REJECT (a, d) | 3033 / 3073 | Adaptive Otsu at the default DPI: no total on all 8 photos, many junk lines (23 → 83 on one) |
| 2026-11-23 | E1 | web-current → web-tess-thresh2 | 2/5, extra 3, rec 0%, total 100% | not run | TUNING PASSED (provisional, 1 receipt) | 1127 / 1169 | Sauvola: lost the total on 2 photos (good-guy, item-with-addon). Not adopted: 1 tuning receipt |
| 2026-11-23 | E1 | web-tess-dpi300 → web-tess-thresh1-dpi300 | 2/5, extra 3, rec 0%, total 100% | not run | TUNING PASSED (provisional, 1 receipt) | 2043 / 2106 | Fewer items on 7 of 8 photos (e.g. quantity2case 9 → 3 items, no total). Not adopted |
| 2026-11-23 | E1 | web-tess-dpi300 → web-tess-thresh2-dpi300 | 0/5, extra 1, rec 0%, total 100% | not run | REJECT (a) | 1123 / 1262 | Lost the total on 3 photos, found one on less-contrast, and misread price-diff's (163.17 → 183.17) |
| 2026-11-23 | E4 | web-current → web-tess-rotate | 0/5, extra 2, rec 0%, total 100% | not run | REJECT (a) | 1093 / 1249 | Text changed on 5 of 8 photos: el-chalan stopped adding up, one total misread (163.17 → 183.17) |
| 2026-11-23 | E4 | web-current → web-tess-nodict | 0/5, extra 2, rec 0%, total 100% | not run | REJECT (a) | 1063 / 1228 | Byte-identical on all 8: `load_system_dawg` / `load_freq_dawg` don't reach the LSTM's dictionary in OEM 1 |
| 2026-11-23 | E4 | web-current → web-tess-nolstmdict | 0/5, extra 4, rec 0%, total 100% | not run | REJECT (a, c) | 1017 / 1187 | `lstm_use_matrix 0` at init (the LSTM's own dictionary switch) does change the reads. Mean line confidence fell (e.g. 69 → 54), and 2 photos lost their total |
| 2026-11-23 | — | web-current → web-tess-no-interword | 0/5, extra 2, rec 0%, total 100% | not run | REJECT (a) | 963 / 1126 | Byte-identical on all 8: lines are rebuilt from words, so the setting doesn't matter |

Task 8 rows (E2, Chromium 159, 8 photos, one run each, 2026-11-23). Same data limits as above: the eval scored 1 checked tuning receipt (`diff-quantity-size`); held-out wasn't run (no `--confirm`). Each `web-crop-thN` is `web-crop-canvas` plus the text-height second pass at target N px line boxes, band ±15%, so against `web-crop-canvas` the second pass is the only factor. "OK" below means C2's `assessQuality` (what the app sees at runtime), not ground truth. Median ms are over all 8 photos (ocr / total); web-current 994 / 1090, web-crop-canvas 837 / 1314.

| date | experiment | baseline → candidate | tuning | held-out | verdict | median ms ocr / total | notes |
|---|---|---|---|---|---|---|---|
| 2026-11-23 | E5 re-run | web-current → web-crop-canvas | 4/5, extra 1, rec 0%, total 100% (baseline 0/5, extra 2) | not run | TUNING PASSED (provisional, 1 receipt) | 837 / 1314 | Fresh baseline for E2. Crop applied on 3 of 8 photos. It fixed diff-quantity-size but broke el-chalan's reconciliation (the crop's 676×1174 isn't upscaled, so lines fell from 35 to 24 px) |
| 2026-11-23 | E2 | web-crop-canvas → web-crop-th28 | 4/5, extra 1 (same) | not run | REJECT (a) | 1306 / 1817 | Second read on 7 of 8; mostly shrinking (first-pass medians 34–82 px). Didn't fire on el-chalan (24 px is in band), so it stays broken. Shrinking changed which read won on item-with-addon and price-diff (see the pickBetter note under the table) |
| 2026-11-23 | E2 | web-crop-canvas → web-crop-th34 | 4/5, extra 1 (same) | not run | REJECT (a) | 1308 / 1883 | **Rescued el-chalan** (24 → 34 px, OK again). Second read on 7 of 8 |
| 2026-11-23 | E2 | web-crop-canvas → web-crop-th40 | 4/5, extra 1 (same) | not run | REJECT (a) | 1162 / 1564 | **Rescued el-chalan** (24 → 40 px, OK). Second read on only 4 of 8 (34–46 px is in band), and no OK/not-OK change on any other photo. Cheapest of the four |
| 2026-11-23 | E2 | web-crop-canvas → web-crop-th46 | 4/5, extra 1 (same) | not run | REJECT (a) | 1243 / 1931 | Rescued el-chalan (to 1179×2048, at the cap). Upscaled price-diff to the cap with no change |

E2 summary: on the one checked receipt, no target changes the score, so `decide` (a) rejects all four against `web-crop-canvas`. All four "pass" against `web-current`, but only because of the crop. On the unchecked photos, th34 and th40 undo the one harm the crop did (el-chalan), with no other OK→not-OK change, and th40 does it with the fewest extra reads. That matches the earlier evidence: a sharp 866×1390 receipt read best at ~35 px lines and worse when blown up. Not adopted. Re-check th40 (and th34) once more answer files are `checked: yes`.

**pickBetter note (C2, not changed here):** a read with `no_total` has `gapCents` 0, so between two not-ok reads with one problem each, it beats a read that found a total but doesn't add up. On item-with-addon, th28/th34 kept a 2–3 item read with no total over a 4-item read with a total. Worth a look when C2 is next revisited.

Task 9 rows (E3, Chromium 159, 8 photos, one run each, 2026-11-23). Data limits as before: the eval scored **1 checked tuning receipt** (`diff-quantity-size`), held-out was not run (no `--confirm`), so every verdict is PROVISIONAL. Each enhance variant hands its image to Tesseract as lossless PNG. "OK n/8" counts C2's `assessQuality` over all 8 photos (what the app sees at runtime, not ground truth); fresh baselines from the same run: web-current 3/8, web-crop-canvas 2/8, web-crop-th40 3/8. Median ms over all 8 photos (enhance / ocr / total): web-current 0 / 914 / 1069, web-crop-canvas 0 / 814 / 1275, web-crop-th40 0 / 1096 / 1477. Every enhanced image kept 201–256 grey levels (criterion 43; `meta.enhance` in each ocr.json), and no variant is "too slow" (largest added time +980 ms, th40-flatten-clahe vs th40).

| date | experiment | baseline → candidate | tuning | held-out | verdict | median ms enhance / ocr / total | notes |
|---|---|---|---|---|---|---|---|
| 2026-11-23 | E3 gray | web-crop-canvas → web-crop-gray | 4/5, extra 1 (same) | not run | REJECT (a) | 12 / 813 / 1293 | OK 2/8 (same count, different photos): good-guy stopped adding up (51.11 total read), el-chalan became OK. Grey + PNG handoff alone changes reads on 5 of 8 |
| 2026-11-23 | E3 flatten | web-crop-gray → web-crop-flatten | 4/5, extra 1 (same) | not run | REJECT (a) | 36 / 901 / 1249 | OK 2/8. Good-guy OK again; el-chalan not OK; item-with-addon and price-diff lost items |
| 2026-11-23 | E3 clahe | web-crop-flatten → web-crop-flatten-clahe | 4/5 (exact 3), extra 1 | not run | REJECT (a); CLAHE doesn't beat flatten alone | 51 / 878 / 1425 | OK 1/8: quantity2case lost its total; price-diff 5 → 2 items |
| 2026-11-23 | E3 gray (on th40) | web-crop-th40 → web-crop-th40-gray | 4/5, extra 1 (same) | not run | REJECT (a) | 15 / 1149 / 1551 | OK 2/8 (good-guy stops adding up, as without th40) |
| 2026-11-23 | E3 flatten (on th40) | web-crop-th40-gray → web-crop-th40-flatten | 4/5, extra 1 (same) | not run | REJECT (a) | 63 / 1583 / 2126 | OK 3/8 (same photos as web-crop-th40); item-with-addon 4 → 1 items, price-diff lost its total |
| 2026-11-23 | E3 clahe (on th40) | web-crop-th40-flatten → web-crop-th40-flatten-clahe | 4/5 (exact 3), extra 1 | not run | REJECT (a); CLAHE doesn't beat flatten alone | 69 / 1582 / 2458 | OK 2/8: quantity2case lost its total again |

E3 summary: on the one checked receipt no enhance step changes the score, so `decide` (a) rejects every step; none is adopted and production is unchanged. On the unchecked photos nothing helps either: grey alone already moves reads around (Tesseract converts to grey itself, so this is mostly the PNG handoff and luma weights), flattening never adds an OK and costs items on two photos, and CLAHE is worse than flatten alone on both bases. None of the 8 photos has strong uneven lighting, which is what flattening is for, so this says little about shadowed receipts; re-check once more answer files are `checked: yes` and the set has a shadowed receipt (C1 coverage list).

**Line-height estimate note:** the flatten kernel is 4 × a text-row height measured from the image's horizontal-gradient profile (`web/cv/enhance.ts`). On real photos that run height is shorter than Tesseract's line boxes (about 0.45–0.9× with the threshold at 10% of the profile range; 2–7× shorter with a midpoint, which is why 10% was chosen, backed by a synthetic ascender test). That diagnostic compared the estimate with Tesseract's own line heights on all 8 photos and used no scores or answer files. On 2 photos the estimate was 4–6 px (kernel 17–25 px), which still clears the glyph strokes the closing has to remove. If flatten is revisited, measuring line pitch is the next thing to try.

Task 11 rows (the retry, Chromium 159, 8 photos, one run each, 2026-11-24). **Every scored verdict here rests on 1 checked tuning receipt** (`diff-quantity-size`). The only other checked file, `less-contrast`, is held-out, and held-out was not run (no `--confirm`). The other 6 answer files are `checked: no`. `web-current`, `web-crop-canvas`, `web-crop-th28/34/40` were re-read first with the fixed `pickBetter` (below), because the text-height variants use it to choose between their two passes. "OK n/8" counts C2's `assessQuality` over all 8 photos: what the app sees at runtime, not ground truth. Fresh singles: web-current OK 3/8, median total 1068 ms; web-crop-canvas OK 2/8, 1259 ms; web-crop-th40 OK 3/8, 1471 ms. A flow's time is primary total + retry total when it retried. The real app shares one Tesseract worker, so this is an upper bound.

| date | experiment | primary → retry | tuning (flow) | held-out | verdict | retried / retry chosen (of 8) | OK n/8 | median / max total ms (median retry cost) | notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-24 | Task 11 | web-current → web-crop-th40 | 4/5, extra 1, rec 0%, total 100% (web-current alone: 0/5, extra 2) | not run | PROVISIONAL, 1 receipt: same score as web-crop-th40 alone | 5 / 1 | 3 (same as web-current) | 2212 / 3054 (1450) | The retry won only on diff-quantity-size (the crop's win). On the other 4 not-OK photos the retry read the same text: no crop found and line height in band, so it repeated the primary. It rescued no not-OK read |
| 2026-11-24 | Task 11 | web-crop-th40 → web-current | 4/5, extra 1 (same) | not run | PROVISIONAL, 1 receipt: no gain over web-crop-th40 alone | 5 / 0 | 3 | 2367 / 3054 (1112) | The retry was never chosen. The whole-photo read wasn't better than the crop on any photo |
| 2026-11-24 | Task 11 | web-current → web-crop-canvas | 4/5, extra 1 (same) | not run | PROVISIONAL, 1 receipt | 5 / 1 | 3 | 2134 / 2705 (1332) | Same pattern as → th40: the crop helped only on diff-quantity-size |
| 2026-11-24 | Task 11 | web-crop-canvas → web-current | 4/5, extra 1 (same) | not run | PROVISIONAL, 1 receipt | 6 / 1 | 3 (web-crop-canvas alone: 2) | 2228 / 2705 (1089) | The retry rescued el-chalan, which only undoes the crop's own harm there. web-crop-th40 does the same in one attempt |

Task 11 summary: on the one checked tuning receipt, every pair scores the same as its cv variant alone (4/5). On the unchecked photos no retry turns a not-OK read into OK, except undoing the crop's harm. The 4 photos that stay not-OK fail the same way under every variant (no total on 2, sums off on 2), so a second read with these variants can't fix them. They need a different read, such as zoom on doubt (Task 13) or the user typing the total. Of the pairs, current → crop-th40 costs OpenCV only on a failed read, and crop-th40 → current never chose its retry. Nothing ships: `PIPELINE.web = WEB_PLANS.current`, no retry. Task 14 decides once more answer files are `checked: yes`. **Possible optimisation (not built):** when the retry would read the same image as the primary (no crop found, no second pass), skip it. That saves about 1.1–1.5 s on most failing photos here (C3 allows reuse).

**pickBetter fix (Task 11, amends C2; the Task 8 note above).** The new order: ok; then has items; then enough lines; then has a total; then smaller `gapCents`; then fewer failed totals checks; then more items; then more lines; on a full tie, the first read. A read that found something beats one that found less, whatever the gaps. The gap size now comes before the count of failed checks, because two checks off by 2¢ are closer than one off by $50. Effect: on item-with-addon, th28 and th34 now keep the 4-item read that has a total (before the fix: a 2–3 item read with no total). Tuning scores didn't change (diff-quantity-size 4/5 for th28, th34, th40). Criterion 18 still holds: each step decides one test, in both argument orders (`assessQuality.test.ts`).

**Harness fix (Task 9):** cv variants now build OpenCV into `eval/receipts/.harness-opencv-<pid>/` (served as `/opencv/`, re-checked before every photo, removed at the end), so `npm run web` / `start` deleting `public/opencv/` can't affect a run. A cv run whose trace has `unavailable` / `fallback`, that made no successful cv call, or whose `cvLoad` is under 50 ms fails the harness (exit 1) and is not written. Shown end to end: deleting the private worker mid-run gave "OpenCV files missing … nothing written" for the 6 remaining photos and exit 1.

Task 13 rows (E9, zoom on doubt, Chromium 159, 8 photos, one run each, 2026-11-24). **Every scored verdict rests on 1 checked tuning receipt** (`diff-quantity-size`); held-out was not run (no `--confirm`). "OK n/8" counts C2's `assessQuality` over all 8 photos (what the app sees at runtime, not ground truth). Fresh baselines from the same run: web-current OK 3/8 (good-guy, el-chalan, quantity2case), median ocr / total 981 / 1150 ms; web-crop-th40 OK 3/8 (same photos), 1118 / 1532 ms. "Re-reads" = extra single-line Tesseract calls per receipt (median / max); "replaced" = rows whose re-read passed `acceptZoomRead`, over all 8 photos.

| date | experiment | baseline → candidate | tuning | held-out | verdict | median ms ocr / total | re-reads median / max | notes |
|---|---|---|---|---|---|---|---|---|
| 2026-11-24 | E9 | web-current → web-current-zoom | 0/5, extra 2, rec 0%, total 100% (same as baseline) | not run | REJECT (a) | 1190 / 1240 | 7.5 / 8 | OK 3/8 (no change). 3 rows replaced on 2 photos. On diff-quantity-size the one replacement was **wrong**: "Eas] $35.00" (conf 25) re-read as "a $36.00" (37), and pickBetter kept it because the gap shrank by $1. On less-contrast two priceless rows gained prices (items 6 → 8), still no total |
| 2026-11-24 | E9 | web-crop-th40 → web-crop-th40-zoom | 4/5, extra 1 (same) | not run | REJECT (a) | 1519 / 1922 | 8 / 16 | OK 3/8 (no change). Zoom runs after each pass, so a two-pass photo gets up to 16 re-reads. Replacements: el-chalan "PESCADO AL AJILLO 11815,95" → "… 1 $15.95" (right, 69 → 89; the photo was OK already), a right Chicken Burrito fix on eaddon that pickBetter didn't keep, and the same two less-contrast rows |
| 2026-11-24 | E9 | web-current → web-crop-th40-zoom | 4/5, extra 1 | not run | TUNING PASSED (provisional, 1 receipt) | 1519 / 1922 | 8 / 16 | The whole gain is the crop's (web-crop-th40 alone scores the same). Not adopted |

E9 summary: zoom on doubt changed no OK/not-OK outcome on any of the 8 photos and didn't move the one checked score, so `decide` (a) rejects both zoom variants against their bases; nothing ships, production is unchanged. Of the 42 + 71 rows re-read, almost all came back at *lower* confidence than the page read. The motivating misreads weren't fixed: price-diff's "Tax $10.4" re-read as "Tac na" (63 vs 70); diff-quantity-size's Saratoga row ("$9.00" printed) was re-read and came back "$3.00" again (web-current-zoom, 33 vs 64) or as junk (th40-zoom). Why it doesn't help on these photos: they are small (253–480 px wide) and upscaled before the first read, so a row crop has no detail the page read lacked (spec Risks), and on tilted photos Tesseract's line boxes overlap their neighbours, so the crop holds slivers of other rows and PSM 7 reads them as text. On the one sharp photo (el-chalan, 866 px) the re-reads reproduced the page read almost exactly and fixed the one broken price, which suggests it can help on sharp, larger photos. Cost: +~0.1–0.4 s per re-read, well inside the 25 s budget (criterion 62). Risk seen: one confident wrong replacement ($35 → $36) passed the accept rule and pickBetter. If revisited: require the replaced price to make a totals check reconcile (not just shrink the gap), and re-check once the set has larger, sharper photos with checked answers.

Task 12 rows (E8, strip tiling, Chromium 159, one run each, 2026-11-24). **Scored verdicts rest on 3 checked tuning receipts** (`diff-quantity-size`, `eaddon-line-price`, `good-guy`; the brief for this task said 1, but more answer files are `checked: yes` now); held-out was not run (no `--confirm`). None of the 8 photos is a long receipt, so the trigger (crop height / width ≥ 2.5 and height > 1.25 × 2048) never fired on them: `stages.tiles` 0 and the lines **byte-identical** to the base variant on all 8 photos, for both pairs. Median ms over the 8 photos (ocr / total): web-crop-canvas 848 / 1309, web-crop-strips 832 / 1325, web-crop-th40 1124 / 1523, web-crop-th40-strips 1175 / 1572 (run-to-run noise; no extra work runs when the trigger is false, not even the row-ink profile).

| date | experiment | baseline → candidate | tuning | held-out | verdict | median ms ocr / total | notes |
|---|---|---|---|---|---|---|---|
| 2026-11-24 | E8 | web-crop-canvas → web-crop-strips | 8/11, extra 4, rec 33.3%, total 100% (same as baseline) | not run | REJECT (a) (no change, as expected) | 832 / 1325 | No harm: tiling didn't trigger on any of the 8 photos; reads byte-identical to the base |
| 2026-11-24 | E8 | web-crop-th40 → web-crop-th40-strips | 8/11, extra 4 (same) | not run | REJECT (a) (no change, as expected) | 1175 / 1572 | Same: no trigger, byte-identical on all 8 |

**Synthetic long receipt** (not a photo and not in the eval set: generated text rendered with Chromium's canvas, 100 items + header, subtotal, tax, total = 107 text lines, 22 px monospace, ~39 px pitch, a 700 × 4400 receipt, 1:6.3). Two images: the receipt alone ("full": locate finds nothing, the photo itself is tiled) and on a dark table ("table": locate + crop, crop 658 × 3952 after the 4096 decode cap). Lines are "exact" when an OCR line equals the printed line; items scored by C1's `scoreReceipt` against the generated truth.

| image | variant | read at | median line px | lines exact / 107 | items matched / 100, extra | total right | ocr / total ms |
|---|---|---|---|---|---|---|---|
| full | web-current, web-crop-canvas, web-crop-th40 (identical) | 326 × 2048 | 9 | 66 | 74, extra 20 | yes | ~1.2–1.4 s / ~1.5–1.6 s |
| full | web-crop-strips (= th40-strips) | 3 strips, 700 wide | 17 | 102 | **97, extra 0** | yes | 2.1 s / 2.5 s |
| table | web-current | 401 × 2048 | 8 | 49 | 54, extra 29 | no | 1.3 s / 1.4 s |
| table | web-crop-canvas (= th40) | 341 × 2048 | 11 | 65 | 72, extra 26 | yes | 1.3 s / 1.8 s |
| table | web-crop-strips | 3 strips, 658 wide | 20 | 104 | **99, extra 0** | yes | 2.0 s / 2.5 s |
| table | web-crop-th40-strips | 3 strips + 6 strips at 2× (second pass) | 20 | 104 | 99, extra 0 | yes | 5.1 s / 5.6 s |

E8 summary: on the 8 real photos strip tiling is inert (no trigger, byte-identical, no added time), so it does no harm to normal receipts; `decide` (a) rejects it there only because nothing changes. On the synthetic long receipt it is the difference between a mostly unreadable read (text at 8–11 px after the 2048 px shrink: 54–74 of 100 items, 20–29 junk items) and a near-complete one (97–99 of 100, no junk, no duplicated overlap lines). With th40 the text-height pass then reads the crop again in 6 strips at 2× and keeps the first read (same score, +3 s): th40's second pass adds nothing here. Not adopted (no checked long receipt in the set; Task 14 decides). What this needs before shipping: a few real long receipts with checked answers (C1 coverage list). Built-in limits found while testing, both handled by "no tiling" (today's read): a crop with a sliver of table down its sides (the profile now ignores the outer 5% of columns, `ROW_INK_SIDE_MARGIN`), and a dark block (logo, inverted bar) that a per-band median would call paper (the band's paper is floored at the page median − 60, `ROW_INK_MAX_SHADOW`).

**Implementation notes (Task 12, differences from the spec text):**
- Overlap: one text line past each cut, with the strip edge also in a blank gap (found from the profile), instead of a fixed 1 × pitch, so no strip edge can cut a line. No overlap on a side whose next ink run is taller than 2 pitches (`OVERLAP_MAX_PITCHES`).
- Target strip height: (2048 / strip scale − 4 pitches) / 1.25, not 2048, so a strip with its window and overlaps stays under the 2048 cap and is read at native resolution (a strip that still exceeds it is fitted to the cap).
- `rowInk`: band median − 40 as specified, plus the side margin and the shadow floor above. Band height: a quarter of the width (≥ 16 px).
- A strip read timing out fails the read with `timeout` (a partial page is not a read); cancel ends it at once; every strip image is released as soon as its read ends, and the crop's PNG at the end.
- The decision is made in `normalizeScale` (run.ts passes the variant's `tiling` to it), which returns a `tiles:` handle instead of shrinking the crop; the text-height second pass re-plans the strips at the new scale, or reads the whole crop when the new size fits under the cap.

Task 14 rows (choose what ships, Chromium 159, 8 photos, one fresh run each of 19 variants, 2026-11-24). **Answer files `checked: yes` (`npm run answers:check`): tuning 3 (`diff-quantity-size`, `eaddon-line-price`, `good-guy`), held-out 2 (`less-contrast`, `item-with-addon`).** Drafts: `el-chalan`, `price-diff`, `quantity2case` (all tuning, not scored). That is below A1's 12 / 8, so every verdict is PROVISIONAL. `less-contrast`'s checked answer doesn't add up by itself (items 53.80 vs subtotal 57.30, from `answers:check`), so an item may be missing from it. Not re-run: the OpenCV-resampler variants (`cv-resize-*`, `web-crop`), already shown worse (E-cv0, E5). Tuning was compared first for every candidate; `--confirm` was run **once**, for the one chosen candidate. Flows (`primary → retry`) were scored with the eval's own `simulateFlow` + `decide` over the saved reads (`--compare` takes single variants; the numbers match `--flow`). "OK n/8" = C2's `assessQuality` over all 8 photos (what the app sees, not ground truth). Median ms are over the 8 photos; `cvLoad` in the harness is about 235 ms because OpenCV is served from localhost (no download), so it is the compile/start-up floor only.

| date | experiment | baseline → candidate | rule | tuning Σmatched/Σexpected, extra (per receipt dqs / eaddon / good-guy) | held-out | verdict + clause | OK n/8 | median ms ocr / total | notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-24 | baseline | web-current | — | 4/11, extra 5, rec 33%, total 100% (0/5, 1/3, 3/3) | 1/12, extra 9, rec 0%, total 0% (shown only by the one `--confirm`) | — | 3 | 928 / 1089 | |
| 2026-11-24 | E5 core crop | web-current → web-crop-canvas | decideCore | 8/11, extra 4, rec 33%, total 100% (4/5, 1/3, 3/3) | 1/12, extra 9 (identical lines on both held-out receipts) | **ADOPT (provisional)**, `--confirm` 2026-11-24 | 2 | 828 / 1294 (cvLoad 236; max 2155) | Also passes plain `decide` (+4 ≥ guard 2). Crop applied on 3 of 8 photos: diff-quantity-size (quad, 0.84), good-guy (mask, 0.90; same score), el-chalan (draft). On both held-out receipts locate found no confident outline (less-contrast quad 0.44, item-with-addon none), so the crop was the identity and **held-out says nothing about the crop itself**. Harm seen on an unchecked photo: el-chalan loses "PESCADO AL AJILLO 15.95" and goes from OK to not OK (`items_vs_subtotal`, gap 15.95) |
| 2026-11-24 | E2 | web-crop-canvas → web-crop-th28 | decide | 9/11, extra 3 (4/5, 2/3, 3/3) | not run | REJECT (a): +1 < guard 2 | 2 | 1272 / 1815 | The one gain is a Chicken Burrito line on eaddon |
| 2026-11-24 | E2 | web-crop-canvas → web-crop-th34 | decide | 8/11, extra 4 (same) | not run | REJECT (a) | 3 | 1253 / 1842 | Undoes el-chalan's crop harm (unchecked) |
| 2026-11-24 | E2 | web-crop-canvas → web-crop-th40 | decide | 8/11, extra 4 (same) | not run | REJECT (a) | 3 | 1115 / 1518 | Undoes el-chalan's crop harm (unchecked), cheapest of the four |
| 2026-11-24 | E2 | web-crop-canvas → web-crop-th46 | decide | 8/11, extra 4 (same) | not run | REJECT (a) | 3 | 1198 / 1862 | |
| 2026-11-24 | E8 | web-crop-canvas → web-crop-strips | decide | 8/11, extra 4 (same) | not run | REJECT (a) | 2 | 858 / 1293 | No photo triggers tiling; reads identical |
| 2026-11-24 | E8 | web-crop-canvas → web-crop-th40-strips | decide | 8/11, extra 4 (same) | not run | REJECT (a) | 3 | 1130 / 1525 | = th40 (no trigger) |
| 2026-11-24 | E9 | web-current → web-current-zoom | decide | 4/11, extra 5 (same as baseline) | not run | REJECT (a) | 3 | 1239 / 1289 | |
| 2026-11-24 | E9 | web-crop-canvas → web-crop-th40-zoom | decide | 8/11, extra 4 (same) | not run | REJECT (a) | 3 | 1521 / 1974 | |
| 2026-11-24 | E3 | web-crop-canvas → web-crop-gray | decide | 7/11, extra 4 (4/5, 0/3, 3/3; good-guy total wrong) | not run | REJECT (a, d) | 2 | 824 / 1311 | |
| 2026-11-24 | E3 | web-crop-canvas → web-crop-flatten | decide | 7/11, extra 4 (4/5, 0/3, 3/3) | not run | REJECT (a) | 2 | 896 / 1253 | |
| 2026-11-24 | E3 | web-crop-canvas → web-crop-flatten-clahe | decide | 7/11, extra 2 | not run | REJECT (a) | 1 | 886 / 1440 | |
| 2026-11-24 | E3 | web-crop-th40 → web-crop-th40-flatten | decide | 7/11, extra 4 | not run | REJECT (a) | 3 | 1590 / 2147 | |
| 2026-11-24 | E1 | web-current → web-tess-thresh2 | decide | 6/11, extra 7 (good-guy total wrong) | not run | REJECT (c, d) | 1 | 1109 / 1148 | |
| 2026-11-24 | E4 | web-current → web-tess-rotate | decide | 4/11, extra 5 (same) | not run | REJECT (a) | 2 | 1059 / 1204 | |
| 2026-11-24 | retry | web-crop-canvas → flow web-crop-canvas, web-current | decide | 8/11, extra 4 (same as the crop alone; the retry was never chosen on tuning) | not run | REJECT (a) vs the crop alone | 3 | — | On el-chalan (unchecked) the retry rescues the crop's harm (Task 11) |
| 2026-11-24 | retry | web-crop-canvas → flow web-current, web-crop-canvas | decide | 8/11, extra 4 (same) | not run | REJECT (a) vs the crop alone | 3 | — | Ties the crop on tuning; the crop then runs only when today's read fails. Not D4's "crop first" |
| 2026-11-24 | retry | web-crop-canvas → flows web-current ↔ web-crop-th40, web-current → web-crop-th28 | decide | 8/11 (th40 both ways), 9/11 (th28) | not run | REJECT (a) vs the crop alone | 3 | — | |

Task 14 summary: the only change with a measured gain on checked receipts is the **core crop** (`web-crop-canvas`, 4/11 → 8/11 on tuning, all from `diff-quantity-size`, the small-receipt-in-a-big-frame case D4 is about). It passes `decideCore` and also plain `decide`, and its one `--confirm` showed no held-out harm, but only because the crop didn't fire on either held-out receipt. Every optional step on top of it (text-height pass 28–46, strips, zoom, grey / flatten / CLAHE, the retries) ties or is worse on tuning, so none passes `decide` (a). Line-item accuracy against ADR 0010's 85%: tuning 72.7% with the crop (36.4% today), held-out 8.3% either way, far below 85% on web. Decision: § Decision (proposed) below.

QA-gap rows (criteria 41 and 45, Chromium 159, 8 photos, one fresh run each of `web-current`, `cv-resize-jpeg`, `cv-resize-png`, `web-crop`, `web-crop-canvas`, `web-crop-canvas-psm4`, `web-crop-th40`, 2026-11-25). Same checked answers as Task 14: **tuning 3** (`diff-quantity-size`, `eaddon-line-price`, `good-guy`), held-out 2, so every verdict is PROVISIONAL. Tuning only: **no `--confirm` was run** (held-out stays unseen for these rows). "OK n/8" = C2's `assessQuality` over all 8 photos (what the app sees, not ground truth). The fresh baselines match Task 14's scores (web-current 4/11, web-crop-canvas 8/11).

| date | experiment | baseline → candidate | rule | tuning Σmatched/Σexpected, extra (dqs / eaddon / good-guy) | held-out | verdict + clause | OK n/8 | median ms ocr / total | notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-25 | E-cv0 resampler | web-current → cv-resize-jpeg | decide | 6/11, extra 3, rec 33%, total 100% (1/5, 2/3, 3/3) vs 4/11, extra 5 (0/5, 1/3, 3/3) | not run | TUNING PASSED (provisional, 3 receipts: +2 ≥ guard 2). **Not adopted** (below) | 2 (web-current 3) | 962 / 1373 (normalize 270, of which cvLoad 248) | The two gains: one Saratoga line on dqs, "Chips and Queso Blanco" on eaddon. On the unchecked photos it is worse: quantity2case OK → not OK (9 → 5 items), price-diff and item-with-addon lose their total |
| 2026-11-25 | E-cv0 PNG | cv-resize-jpeg → cv-resize-png | decide | 3/11, extra 4, rec 0%, total 66.7% (0/5, 1/3, 2/3) | not run | REJECT (a, d) | 0 | 1075 / 1427 | Lossless handoff of the OpenCV resize is worse everywhere: good-guy loses its total and reads "Dos Tacos 16.00" (18.00 printed); el-chalan and quantity2case not OK |
| 2026-11-25 | E-cv0 on the crop (E5 re-run) | web-crop-canvas → web-crop | decide | 8/11, extra 4, rec 0%, total 66.7% (3/5, 2/3, 3/3; good-guy total read 51.11) | not run | REJECT (a, d) | 0 (web-crop-canvas 2) | 854 / 1276 | The resampler is the only factor here (both crop the same way). On dqs the cv resize misreads "Cape Town Margarita 90.00" as 30.00; good-guy stops adding up; quantity2case, price-diff and item-with-addon as in cv-resize-jpeg |
| 2026-11-25 | PSM 4 after crop | web-crop-canvas → web-crop-canvas-psm4 | decide | 9/11, extra 3, rec 33%, total 66.7% (4/5, 2/3, 3/3; good-guy total lost) | not run | REJECT (a, d): +1 < guard 2, and a total lost | 0 (web-crop-canvas 2) | 746 / 1190 | PSM 4 gains "Chips and Queso Blanco" on eaddon but loses the total on good-guy (checked), quantity2case and item-with-addon (which now reads 0 items); price-diff's total is misread (1,683.17 vs 163.17). It finds a total on less-contrast that the crop alone didn't, but the sums are off. Same finding as A4.1 on the rendered receipt: PSM 6 stays, crop or not |

**E-cv0 per photo** (items read, total found, OK; checked photos also show tuning matched/expected):

| photo (set) | web-current | cv-resize-jpeg | cv-resize-png | web-crop-canvas | web-crop |
|---|---|---|---|---|---|
| diff-quantity-size (tuning) | 0/5; 2 items, total, sums off | 1/5; 2 items, total, sums off | 0/5; 1 item, total, sums off | 4/5; 5 items, sums off by 6.00 | 3/5; 5 items, sums off by 66.00 |
| eaddon-line-price (tuning) | 1/3; no total | 2/3; no total | 1/3; no total | 1/3; no total | 2/3; no total |
| good-guy (tuning) | 3/3; **OK** | 3/3; **OK** | 2/3; no total | 3/3; **OK** | 3/3; total misread, sums off |
| item-with-addon (held-out, not scored) | 4 items, sums off | 3 items, no total | 4 items, no total | 4 items, sums off | 3 items, no total |
| less-contrast (held-out, not scored) | 6 items, no total | 8 items, no total | 7 items, no total | 6 items, no total | 8 items, no total |
| el-chalan (draft) | **OK** | **OK** | sums off | sums off (crop harm, Task 14) | sums off |
| price-diff (draft) | sums off | no total | no total | sums off | no total |
| quantity2case (draft) | **OK** (9 items) | 5 items, sums off | 6 items, sums off | **OK** | 5 items, sums off |

E-cv0 summary: the result is **mixed, not the clean "OpenCV resampler reads worse" the earlier notes assumed**. On the whole photo, the OpenCV resize (INTER_AREA / INTER_CUBIC + JPEG 0.9) gains 2 items on the 3 checked tuning receipts and passes `decide` on tuning, but it costs OpenCV on every scan (+~250 ms load, an 11 MB download) and makes 3 of the 5 unchecked photos worse in what the app sees (OK 3/8 → 2/8, two totals lost, one 9 → 5 item read). On the crop path, where it would actually ship, the same resampler loses to the canvas outright (`web-crop` vs `web-crop-canvas`: REJECT (a, d), OK 2/8 → 0/8). The PNG handoff is worse still. So resizing stays on the canvas path (`web-crop-canvas`, Task 14's choice), and `cv-resize-jpeg` is not adopted. No `--confirm`; re-check `cv-resize-jpeg` vs `web-current` once the draft answers (el-chalan, price-diff, quantity2case) are checked, since those are the photos it hurt.

PSM 4 summary: after the crop, PSM 4 reads faster (ocr median 865 → 746 ms) but loses totals (one checked, three unchecked) and reads nothing usable on item-with-addon. Not adopted; production keeps PSM 6 (`TESSERACT_PARAMS`). The variant stays in `VARIANTS` for re-checks.

**Per-stage median timings (criterion 45).** Medians over the 8 photos, in ms, from each variant's `meta.timingsMs` (the harness already records every stage; no harness change was needed). How to read them: the first OpenCV call loads and compiles OpenCV, so its stage includes `cvLoad`: `locate` on crop variants (locate alone is a median 25 ms), `normalize` on `cv-resize-*` (the resize alone is a median 26 ms). `crop` has median 0 because only 3 of 8 photos are cropped; when it runs it takes 10, 34 and 375 ms (375 on the 3072 × 4080 good-guy photo). "− cvLoad" is the median of (total − cvLoad) per photo, the number criterion 45's 4000 ms budget compares.

Main candidates (fresh run, 2026-11-25):

| variant | decode | cvLoad | locate | crop | normalize | enhance | ocr | total | max total | total − cvLoad | vs web-current (− cvLoad) | OK n/8 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| web-current | 6 | 0 | 0 | 0 | 54 | 0 | 991 | 1173 | 1438 | 1173 | — | 3 |
| web-crop-canvas | 4 | 270 | 300 | 0 | 53 | 0 | 865 | 1378 | 2389 | 1096 | −77 | 2 |
| web-crop-th40 | 4 | 252 | 284 | 0 | 70 | 0 | 1170 | 1582 | 2385 | 1340 | +167 | 3 |

None is "too slow" (the largest added median, excluding `cvLoad`, is +167 ms against the 4000 ms budget).

Every other variant, from its most recent saved run (date = that run; Chromium 159, 8 photos; run-to-run noise between days is about ±100 ms on `ocr`):

| variant | run | decode | cvLoad | locate | crop | normalize | enhance | ocr | total | max total |
|---|---|---|---|---|---|---|---|---|---|---|
| cv-resize-jpeg | 11-25 | 4 | 248 | 0 | 0 | 270 | 0 | 962 | 1373 | 1467 |
| cv-resize-png | 11-25 | 4 | 249 | 0 | 0 | 266 | 0 | 1075 | 1427 | 1585 |
| web-crop | 11-25 | 4 | 248 | 283 | 0 | 20 | 0 | 854 | 1276 | 1769 |
| web-crop-canvas-psm4 | 11-25 | 4 | 259 | 294 | 0 | 51 | 0 | 746 | 1190 | 2251 |
| web-crop-gray | 11-24 | 4 | 233 | 259 | 0 | 52 | 12 | 824 | 1311 | 2361 |
| web-crop-flatten | 11-24 | 4 | 233 | 254 | 0 | 52 | 36 | 896 | 1252 | 2517 |
| web-crop-flatten-clahe | 11-24 | 4 | 232 | 261 | 0 | 54 | 50 | 886 | 1440 | 2804 |
| web-crop-strips | 11-24 | 4 | 234 | 258 | 0 | 52 | 0 | 858 | 1292 | 2258 |
| web-crop-th28 | 11-24 | 4 | 240 | 271 | 0 | 70 | 0 | 1272 | 1814 | 3276 |
| web-crop-th34 | 11-24 | 4 | 232 | 258 | 0 | 80 | 0 | 1253 | 1842 | 3194 |
| web-crop-th46 | 11-24 | 4 | 234 | 259 | 0 | 86 | 0 | 1198 | 1862 | 2592 |
| web-crop-th40-gray | 11-24 | 4 | 230 | 254 | 0 | 70 | 16 | 1156 | 1560 | 2262 |
| web-crop-th40-flatten | 11-24 | 4 | 234 | 262 | 0 | 88 | 63 | 1590 | 2146 | 3496 |
| web-crop-th40-flatten-clahe | 11-24 | 4 | 235 | 266 | 0 | 74 | 70 | 1595 | 2468 | 3875 |
| web-crop-th40-strips | 11-24 | 4 | 238 | 268 | 0 | 70 | 0 | 1130 | 1524 | 2309 |
| web-crop-th40-zoom | 11-24 | 4 | 236 | 260 | 0 | 72 | 0 | 1520 | 1974 | 2633 |
| web-current-zoom | 11-24 | 4 | 0 | 0 | 0 | 51 | 0 | 1238 | 1288 | 1681 |
| web-tess-rotate | 11-24 | 4 | 0 | 0 | 0 | 52 | 0 | 1058 | 1204 | 1389 |
| web-tess-thresh2 | 11-24 | 4 | 0 | 0 | 0 | 50 | 0 | 1108 | 1148 | 1644 |
| web-tess-thresh1-dpi300 | 11-24 | 4 | 0 | 0 | 0 | 51 | 0 | 1755 | 1816 | 5534 |
| web-tess-dpi300 | 11-23 | 4 | 0 | 0 | 0 | 53 | 0 | 1116 | 1176 | 1533 |
| web-tess-thresh0 | 11-23 | 4 | 0 | 0 | 0 | 53 | 0 | 1062 | 1252 | 1360 |
| web-tess-thresh1 | 11-23 | 4 | 0 | 0 | 0 | 54 | 0 | 3032 | 3073 | 12225 |
| web-tess-thresh2-dpi300 | 11-23 | 4 | 0 | 0 | 0 | 52 | 0 | 1122 | 1262 | 1545 |
| web-tess-nodict | 11-23 | 4 | 0 | 0 | 0 | 52 | 0 | 1063 | 1228 | 1839 |
| web-tess-nolstmdict | 11-23 | 4 | 0 | 0 | 0 | 54 | 0 | 1017 | 1186 | 1472 |
| web-tess-no-interword | 11-23 | 4 | 0 | 0 | 0 | 54 | 0 | 962 | 1126 | 1446 |

No variant's median is "too slow" (the slowest, `web-tess-thresh1`, is about +1.9 s over today's `web-current` median; its max is 12.2 s on one photo). The earlier rows above give only ocr / total because the per-stage medians weren't written down at the time; this table is computed from the same saved files.

## Decision (proposed), 2026-11-24 (Task 14; not applied: the user approves shipping)

**Recommendation:** ship the crop alone on web: `PIPELINE.web = WEB_PLANS['crop-canvas']` (`web-crop-canvas`, no retry) with `WEB_CV_PREPROCESS = true`. No text-height pass, no strips, no zoom, no enhance, no retry. Confidence: **low**. It rests on one receipt (`diff-quantity-size`: 0/5 → 4/5), one tie (`good-guy`, cropped, same score) and one no-op (`eaddon`, not cropped); held-out gives no evidence about the crop because it didn't fire there. It follows the rules in A1 / Q2 (the crop ships alone if it does no harm), and the user's D4 (locate and crop first).

**Known risk (seen on an unchecked photo, so not in the score):** on `el-chalan` the crop shrinks the text (676 × 1174 crop, not upscaled; lines 35 → 24 px), drops one item and turns an OK read into a not-OK one, which in the app means the failure screen ("Retake photo / Type it in", pre-filled) instead of the form. `web-crop-th40` (crop + text-height pass at 40 px) and the plan `crop-canvas-then-current` both avoid this, but neither gains on the checked receipts, so the rules don't adopt them. If the user checks the `el-chalan` (and `price-diff`, `quantity2case`) answer files, re-run Task 14: th40 is the most likely next adoption (+~220 ms median).

**Cost:**
- Download: `opencv.js` 10,872,779 bytes (about 10.9 MB uncompressed; A2.3) plus the worker, fetched on the **first scan** (every scan now crops), on top of Tesseract's ~7 MB. A web export grows from about 17 MB to about 27 MB (A2.3). Gzip / Brotli on the host would shrink the transfer *(unverified: depends on the host)*.
- First-scan time: the download (estimate, not measured on a phone: about 9 s at 10 Mbit/s, about 2 s at 50 Mbit/s) plus compiling the WebAssembly, measured at about 235 ms on this Mac from localhost. Later scans use the browser cache if the host sends cache headers.
- Every scan: median total 1089 → 1294 ms in the harness (+205 ms; max 1384 → 2155 ms), well inside the 4000 ms budget (criterion 45). Median OCR time falls (928 → 828 ms) because the crop is smaller than the photo.

**The change to apply if the user approves** (`lib/scanPipeline/config.ts`; the `crop-canvas` plan entry already exists, added in Task 14 with no behaviour change):
```ts
export const PIPELINE: Record<Platform, PipelinePlan> = {
  web: WEB_PLANS['crop-canvas'],          // was WEB_PLANS.current
  native: { primary: 'native-current', retry: null },
};
export const WEB_CV_PREPROCESS = true;    // was false; also makes `npm run web` / `export:web` copy public/opencv/ (scripts/opencv-assets.mjs reads this line)
```
Tests that assert today's values and need updating in the same change:
- `lib/scanPipeline/config.test.ts`: "ships web-current / native-current with no retry and OpenCV off" (expects `PIPELINE.web` = web-current and the flag false) and "production ships the "current" plan" (`PIPELINE.web` toBe `WEB_PLANS.current`). "the shipped plans are consistent with the master switch" must keep passing (it does with both lines changed together; with only the plan changed it fails `primary_needs_cv`, which is the guard).
- `lib/scanPipeline/web/stages.test.ts`: "the shipped flag is off" (criterion 20), and the cv-off cases that rely on the default (`createWebStages(d) // default = WEB_CV_PREPROCESS`) need an explicit `cvPreprocess: false`.
- Tests that use the real `PIPELINE.web` / flag by default, so their default web scan would now crop (check with a full run after the flip): `__tests__/scanFlow.test.tsx` (its `mockConfig` falls back to the real values), `lib/scanReceipt.web.test.ts`. `scripts/opencv-assets.test.ts` follows the flag and needs no change.
- After the flip: `npm run export:web` and check `dist/opencv/opencv.js` exists and the entry bundle has no OpenCV (criteria 27–29), then the manual Network check (criterion 32).

**Also for the user (outside Task 14's files):** `scanLoadsCv` (`lib/scanScreen.ts`) shows the "first time takes a little longer" line only when the *primary* uses OpenCV; fine for this plan, but a plan with a cv retry only (e.g. `current-then-crop-*`) wouldn't show it. And `less-contrast`'s checked answer doesn't add up (see above); worth a second look with the photo.

## Risks
- **Too little data.** Four receipts can't support any decision (the minimum is 20). Until the user adds photos, the experiments are exploratory and Task 14 can't ship OpenCV.
- **The harness isn't iPhone Safari.** EXIF handling in `createImageBitmap`, `OffscreenCanvas` and memory may differ *(verify)*.
  - An on-phone web check needs the phone to reach the Mac. `127.0.0.1` on the phone is the phone, and the web app's sign-in needs Supabase.
  - So that check is **blocked** until the Mac's LAN IP plus matching OAuth redirect URLs, a tunnel, or the hosted friend-test project exists. It isn't a criterion here.
- **Memory.** A 4096 px decode plus the warp and a few Mats peaks at roughly 200–300 MB *(estimate)*. The 4096 is a starting value.
- **OpenCV in a worker** may not initialise as expected *(verify)*. If so, Task 6 reports it before Tasks 7–9. The main-thread fallback freezes the UI while it compiles, and it's a scope change that goes to the user.
- **Detection can fail on white or marble tables.** The mask fallback relies on paper being brighter and less saturated than the table, and marble isn't always. Then the crop is the identity, which is no worse than today. Q4 (a manual crop) is the remedy if E5 shows this is common.
- **Harness fidelity** for `web-current` depends on bundling expo-image-manipulator's web source with a shim (Task 4).
- **Smart chunk limits.** Zooming and tiling add **no new pixel information**; they help only by avoiding the 2048 px downscale and by giving Tesseract its preferred text height. Each strip or re-read is another Tesseract call, so scans take longer (budgets in criteria 45 and 62). Cuts must never split characters (criterion 55). Zoom can swap a right read for a confident wrong one, and criteria 59–60 limit that.
- **First-scan download.** It becomes about 7 MB of Tesseract plus about 12 MB of OpenCV. Because D4 makes the crop core, OpenCV is fetched on the primary read once it ships, not only on a retry.

## Open questions for the user (with recommendations)
- **Q1 (blocks Task 14; makes Tasks 5–13 exploratory until answered). Receipt set size.** Is a minimum of 20 checked receipts (12 tuning, 8 held-out) acceptable, aiming for 30? You'd add about 16–26 photos to `receipts/` covering the cases in C1, and correct each pre-filled `expected.json`, which takes a few minutes each. *Recommend:* 30. With fewer, the eval can't tell a real gain from luck.
- **Q2 (blocks Task 14). What if the core crop doesn't pass `decideCore`, or no optional OpenCV step passes `decide`?**
  - (a) Keep the code with `WEB_CV_PREPROCESS = false` and keep copying the assets.
  - (b) Same as (a), but stop copying `opencv.js` into `dist/` until something wins, which saves about 12 MB of hosting.
  - (c) Remove OpenCV.
  - *Recommend:* (b). And if the crop passes `decideCore` (no harm) but nothing else passes, ship the crop alone, because you asked for it as the core step.
- **Q3 (non-blocking). OpenCV build.** *Recommend:* techstark 4.12 now (about 12 MB, lockfile-pinned), and a custom minimal build before production if OpenCV ships.
- **Q4 (non-blocking). Manual crop on web.**
  - (a) Auto-detect only, with a full-image fallback.
  - (b) Show the detected corners after picking and let the host drag them. This adds a step to each web scan, but fixes the white-table case.
  - *Recommend:* decide after E5. If `cropApplied` is false on many tuning receipts, spec (b) next.
- **Q5 (non-blocking). Failure-screen wording when items were read.** "Type it in" opens a pre-filled form, so "Review and fix" might describe it better. *Recommend:* keep your words; the designer may offer an alternative for you to choose.
- **Q6 (blocks the default of `SHOW_FAILURE_SCREEN.native` in Task 3). The failure screen on iPhone/Android now?** The pipeline runs on native with stub stages and no retry. Turning the screen on means a native read that doesn't add up lands on "Retake / Type it in" instead of going straight to the form with the totals banner. *Recommend:* on, because it's your flow and pure JS (tested without a device). The native retry and scanner come in the native spec. Note it hasn't been seen on a device (D1 is still pending).

## Notes for the native spec (not in scope here)
Stage implementations behind the same C3 interfaces:
- **iOS camera:** VisionKit `VNDocumentCameraViewController`, which does locate, crop and flatten itself (`method: 'os-scanner'`).
- **iOS photo picked from the library:** VisionKit's camera can't take existing photos. Use `VNDetectDocumentSegmentationRequest` (iOS 15+) for the quad and confidence, then `CIPerspectiveCorrection` for the warp.
- **Android camera and existing photos:** ML Kit Document Scanner, including its gallery-import mode *(verify that the mode exists and how the plugin exposes it)*. Keep the picker as the fallback when Play services or RAM are missing.
- **Enhance:** none or minimal on Vision and ML Kit (research). At most an A/B of `CIDocumentEnhancer` or the scanner's cleanup.
- **normalizeScale:** ML Kit is fine at the 2048 cap. Vision's `minimumTextHeight` is relative to image height, so strip tiling (C3 `stripTiling.ts`, reusable) also keeps fine print on long receipts from being dropped on iOS.
- `assessQuality`, `run.ts`, the failure screen and the ocr.json format (C1, for E6/E7) are shared as-is.

## Amendment A1 (2026-11-22): user decisions
- **Q1, receipts:** the user added more photos and said to go ahead with what's there: 8 receipts in `receipts/` as of 2026-11-22. Proceed with them, and split tuning vs held-out by the fixed hash as specified. Task 14 makes its decisions on the current set and reports them as **provisional**, plainly saying the held-out set is small. Decisions are re-checked as the user adds receipts. The 20/30 targets stay recommendations, not blockers.
- **Q2:** if OpenCV shows no gain, keep the code tested but switched off, and don't copy `opencv.js` into the build. The crop step ships on its own if it does no harm.
- **Q3:** `@techstark/opencv-js@4.12.0-release.1`, pinned exactly; a custom minimal build before production (add to `docs/before-production.md`).
- **Q4:** decide on a manual crop box after the crop experiment.
- **Q5:** keep the user's wording, "Retake photo" / "Type it in".
- **Q6:** the failure screen is on for native too.
- **ADR numbers assigned by the main session:** 0015 (staged scan pipeline) and 0016 (opencv.js on web).

## Amendment A2 (2026-11-23): facts verified while building Task 6
1. **Worker start-up:** setting `self.Module = { onRuntimeInitialized }` before `importScripts` does **not** work with `@techstark/opencv-js@4.12.0-release.1`: the package declares its own `var Module`. `self.cv` is an Emscripten Module object that has a `then` method; it is not a Promise. The worker waits on that `then` and never resolves a Promise with the module itself, because doing so loops forever. See `lib/scanPipeline/web/cv/worker.ts`.
2. **Criteria 28–29 reworded:** `getBuildInformation` appears 0 times in the text of `opencv.js`, because the name lives inside the embedded wasm. Use `matFromImageData|onRuntimeInitialized` as the OpenCV marker in bundle greps; each appears exactly once in `opencv.js`.
3. **Size:** `dist/opencv.js` is 10,872,779 bytes, not ~12 MB. A web export with it is about 27 MB, against about 17 MB without it.
4. **Jest:** the real OpenCV runs under jest-expo once `window` and `TextDecoder` are swapped for the duration of the load. No separate `test:cv` script is needed.
5. **Harness:** to run cv variants, `preocr:harness` (or Task 7) must build the OpenCV assets with `SPLITIT_OPENCV_ASSETS=1`.

## Amendment A3 (2026-11-23): plain-text answer files replace expected.json
At the user's request, the ground truth for each receipt is now a plain-text answer file, written in dollars the way the receipt reads: `receipts/answers/<photo name without extension>.txt`. Only files with `checked: yes` are scored. Format and workflow: `docs/setup/receipt-answers.md`.
- `npm run answers:draft` writes pre-filled drafts and never overwrites an existing answer.
- `npm run answers:check` validates the files and runs the totals check on each one.
- The tuning / held-out set is recorded once in `eval/receipts/sets.json`, which the user never edits.
- `scripts/eval-init.ts` is retired and now points to `answers:draft`.
- An old `eval/receipts/<name>.expected.json` is read only when a photo has no `.txt`.
Code: `lib/receiptAnswers.ts`, `scripts/answers.ts`, `scripts/answers-cli.ts`, `scripts/evalFiles.ts` (`loadGroundTruth`). Read every reference to `expected.json` / `eval-init` in C1 and Task 1 as meaning these files.

## Amendment A4 (2026-11-23): Task 5 findings
- **Criterion 24 reworded:** a variant's Tesseract parameters go into `recognize`'s options (tesseract.js saves and restores them around each read), not `setParameters`, so a variant's setting never leaks into the next read or the retry on the shared worker. Init-only settings (dictionaries, `lstm_use_matrix`) go through `createWorker`'s config, and the session re-initializes the worker when a later read needs a different init (`reinitWorker`).
- **Result (provisional, 1 checked tuning receipt):** none of the Tesseract settings is adopted. Three made no difference at all (`thresholding_method` 0, `user_defined_dpi` 300, dictionaries off). The other options either made results worse on other photos or barely changed them: Sauvola/LeptonicaOtsu thresholding, the DPI hint combined with those methods, `rotateAuto`, `lstm_use_matrix 0`. Production keeps today's settings. Re-check once more answer files are checked.

## Amendment A5 (2026-11-24): `pickBetter` ranking order (C2)
The C2 order was fixed in Task 11, because the old order let worse reads win. Examples: a read with no total beat one that found the total but was a few cents off, and one check off by $50 beat two checks each off by 2¢. The new order is:
1. ok
2. has items
3. enough lines
4. has a total
5. smaller `gapCents`
6. fewer failed totals checks
7. more items
8. more lines
9. tie: keep the first read

Criterion 18 still holds, with each step deciding one test (both argument orders). This is a correctness fix to an internal ranking rule. It changes nothing the user sees directly; it only makes the better read win.

## Note (2026-11-25): Task 15 docs, ADR numbers
- **ADR numbers changed:** 0015–0017 were already taken by other slices when Task 15 ran, so the staged pipeline is **[ADR 0018](../learning/decisions/0018-staged-scan-pipeline.md)** and OpenCV on web is **[ADR 0019](../learning/decisions/0019-opencv-on-web.md)**. Read "0015" / "0016" in § In scope and Amendment A1 as 0018 / 0019. Logged as S-D-1 in `docs/decisions-to-review.md`.
- **Receipt-eval skill proposal:** written as `docs/lessons/proposals/2026-11-25-receipt-eval-skill-answers.md` (not `2026-11-22-receipt-eval-skill-update.md`), and it describes the A3 answer files rather than `expected.json` / `eval-init`.
- **Gaps found while documenting (closed 2026-11-25: see "QA-gap rows" in § Results log):** § Results log has no E-cv0 rows (criterion 41; the "cv resampler read worse" evidence is only in the `web-crop-canvas` comment in `lib/scanPipeline/config.ts` and the Task 14 note), and no PSM 4-after-crop row or variant (criterion 41, Task 7).
