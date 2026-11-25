# 0019: OpenCV in the browser, self-hosted, lazy, in a Web Worker

**Status:** Accepted (2026-11-25), for how OpenCV is added and loaded. **Whether it is switched on is not decided yet** (decision S-1 in `docs/decisions-to-review.md`). Today `WEB_CV_PREPROCESS = false`, so no user downloads OpenCV and it isn't in the web build.

Spec: `docs/specs/2026-11-22-web-opencv-preprocessing.md` (§ "OpenCV build: recommendation", Task 6, Amendments A1 Q2–Q3 and A2). Part of the staged scan pipeline, [0018](0018-staged-scan-pipeline.md). Follows the self-hosting reasons of [0012](0012-receipt-capture-and-recognition-libraries.md) Decision 3.

> **Numbering note (2026-11-25):** the spec asked for this to be 0016. That number was taken by the time it was written (see the note in 0018).

## Context
On iPhone and Android, the operating system can find a receipt in a photo and straighten it (VisionKit, ML Kit Document Scanner). **Browsers can't.** The pipeline's first stage, "find the receipt and crop to it" ([0018](0018-staged-scan-pipeline.md)), needs image-processing code on web: edge detection, contour finding, perspective warps.

**OpenCV** is the standard open-source library for that. **opencv.js** is OpenCV compiled to WebAssembly so it runs in a browser. It is large: about 11 MB in one file.

The user accepted that cost up front (spec D1: "lets add opencv to web"), with one condition from Amendment A1 (Q2): **if OpenCV doesn't measurably help, keep the code tested but switched off, and don't put `opencv.js` in the build.**

## Decision
### 1. Which build: `@techstark/opencv-js@4.12.0-release.1`, pinned exactly
| Option | Size | For | Against |
|---|---|---|---|
| Official `docs.opencv.org/4.13.0/opencv.js` | 10,964,323 bytes | Smallest prebuilt | Not on npm, so no lockfile pin; we'd have to vendor an 11 MB file or download it at build time |
| **`@techstark/opencv-js` 4.12.0-release.1** (chosen) | `opencv.js` is **10,872,779 bytes** (measured after install, A2.3) | On npm: pinned and integrity-checked by `package-lock.json`. TypeScript types. Works in browsers and Node, so Jest and the harness load the same file. Apache-2.0 | Repackages the official build; not the newest |
| `@techstark/opencv-js` 5.0.0-release.1 | 13,298,869 bytes | Newest | New major line, and the largest |
| A custom minimal build (only the image-processing module) | A few MB *(unverified)* | Much smaller download | Needs the Emscripten toolchain and an OpenCV source build to maintain. **Planned before production** if OpenCV ships (A1 Q3) |

### 2. Self-hosted, never from a CDN
Same reasons as Tesseract in [0012](0012-receipt-capture-and-recognition-libraries.md): privacy (no third party sees who scans), pinned versions, a future strict Content Security Policy, and no dependency on someone else's server.

How the files get there:
- `scripts/copy-opencv-assets.mjs` copies `opencv.js` and its LICENSE from `node_modules` into `public/opencv/`.
- `scripts/build-cv-worker.mjs` uses esbuild to turn `lib/scanPipeline/web/cv/worker.ts` into `public/opencv/receipt-cv-worker.js`.
- Both run in the `prestart`, `preweb` and `preexport:web` hooks in `package.json`, next to the Tesseract copy. `public/opencv/` is gitignored.
- **Both follow the switch.** `scripts/opencv-assets.mjs` reads the line `export const WEB_CV_PREPROCESS = …;` from `lib/scanPipeline/config.ts` as text (`flagFromConfig`, `:38`). While it says `false`, the scripts **delete** `public/opencv/`, so `dist/` has no OpenCV (A1 Q2). The measuring harness builds its own private copy instead (`SPLITIT_OPENCV_ASSETS=1`).

### 3. Lazy: nothing is downloaded until a scan needs it
- The web stages are loaded with `import()` only when a scan starts (`webStagesLoader`, `lib/scanReceipt.web.ts:25`), so they're in a separate chunk, not the bundle every visitor downloads.
- Inside them, the OpenCV client starts the worker on the **first** OpenCV step of a scan (`createCvClient`, `lib/scanPipeline/web/cvClient.ts:121`), never before.
- Metro never bundles OpenCV itself: nothing in the app imports `opencv.js`. The worker loads it from the same site.

### 4. In a classic Web Worker
A **Web Worker** is a background thread in the browser. Compiling 11 MB of WebAssembly and processing a 12-megapixel photo on the page's own thread would freeze the screen, Cancel button included.

It's a **classic** worker (not a module worker) because it loads OpenCV with `importScripts`, which module workers don't support ([MDN, `importScripts`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts)).

Start-up was checked on the installed 4.12 package, and the spec's guess was wrong (A2.1): `self.cv` is an Emscripten module object that has a `then` method but **isn't a Promise**. Setting `self.Module` beforehand doesn't work, and `await cv` loops forever, because the object passes itself to its own callback. The worker waits on it with a small helper (`whenReady`, `lib/scanPipeline/web/cv/worker.ts:28`).

How the page and the worker talk (`lib/scanPipeline/web/cv/protocol.ts`):
- The worker keeps images by id, so a photo is decoded once and reused by locate, crop and resize without re-encoding.
- Messages never carry recognised text or a file name. Errors cross as a code only (`load_failed`, `process_failed`), never library text.
- Every OpenCV image (`Mat`) is freed in a `finally` (`withMats`, `lib/scanPipeline/web/cv/cvApi.ts:124`).
- Photos are decoded at most 4096 px on the long edge (`CV_MAX_DECODE_EDGE`, `protocol.ts:90`), a memory guard: one 4096 × 4096 colour image is about 64 MB.
- Time limits: 30 s for OpenCV to load (`CV_LOAD_TIMEOUT_MS`, `cvClient.ts:39`) and 60 s per operation (`CV_OP_TIMEOUT_MS`, `:46`). Past either, the worker is stopped and the scan carries on without OpenCV ([0018](0018-staged-scan-pipeline.md) §4).

### 5. Only for locate, straighten and enhance. Resizing stays on the canvas
OpenCV could also do the resize step. The harness compared OpenCV's resampler (`INTER_AREA` / `INTER_CUBIC`, variant `web-crop`) with today's browser-canvas resize. **OpenCV's read worse**, so the variant that ships if the crop is turned on (`web-crop-canvas`) uses OpenCV only to find and straighten the receipt. The straightened crop leaves the worker as a lossless PNG, and today's canvas resize applies the size rule to it (comment in `lib/scanPipeline/config.ts:301-306`, `lib/scanPipeline/web/stages.ts:15-21`).

Note: the E-cv0 rows for that comparison never made it into the spec's Results log; the evidence is the Task 7 note above and Task 14's "already shown worse (E-cv0, E5)".

## Costs (measured on this Mac unless marked)
- **Download:** `opencv.js` 10,872,779 bytes (about 10.9 MB uncompressed) plus the worker, on the **first scan** that uses it, on top of Tesseract's ~7 MB. Host compression would shrink the transfer *(unverified: depends on the host)*.
- **Build size:** a web export grows from about 17 MB to about 27 MB when the switch is on.
- **Start-up:** compiling OpenCV took about 235 ms in the harness, served from localhost. On a phone over a network, the download dominates: about 9 s at 10 Mbit/s, 2 s at 50 Mbit/s *(estimate, not measured on a phone)*.
- **Per scan (crop only):** median total 1089 → 1294 ms (+205 ms) in the harness; reading itself got faster (928 → 828 ms) because the crop is smaller than the photo.
- **Memory:** roughly 200–300 MB at peak on a 4096 px photo *(estimate)*.

## What was measured
On 3 checked tuning receipts, the crop raised items found from 4/11 to 8/11 (all on the small-receipt-in-a-big-frame photo), and did no harm on held-out (it didn't fire there). Enhance steps (grey, flatten, CLAHE) and OpenCV resizing didn't help. On one unchecked photo the crop made a good read worse. Details: [the scan pipeline note](../concepts/scan-pipeline.md#how-the-decisions-were-made).

## Consequences
- **No user downloads OpenCV today.** Turning it on is a two-line change in `config.ts` plus test updates (listed in the spec's "Decision (proposed)").
- If it is turned on: the first web scan is several seconds slower on a phone, and the scan screen says "Preparing photo… The first time takes a little longer." (`lib/scanScreen.ts:13`).
- **Not checked in iPhone Safari.** Every measurement ran in Chromium through Playwright. Safari's EXIF handling, `OffscreenCanvas` and memory limits may differ. That check needs the friend-test deploy, because a phone can't reach the Mac's `127.0.0.1`.
- Before production (`docs/before-production.md` §4): a custom minimal build, compression and cache headers for `/opencv/`, the right content type, the build hooks running in the deploy, and `public/opencv/` also being copied into native exports (as `public/tesseract/` is).

## Code
- Worker and start-up: `lib/scanPipeline/web/cv/worker.ts` (`whenReady` `:28`, `bootWorker` `:95`)
- Messages and limits: `lib/scanPipeline/web/cv/protocol.ts` (`CV_WORKER_PATH` `:76`, `CV_MAX_DECODE_EDGE` `:90`)
- Page-side client: `lib/scanPipeline/web/cvClient.ts` (`CV_LOAD_TIMEOUT_MS` `:39`, `CV_OP_TIMEOUT_MS` `:46`, `createCvClient` `:121`)
- Locate and warp: `lib/scanPipeline/web/cv/locate.ts` (`locateDocumentMat` `:406`), `lib/scanPipeline/web/cv/warp.ts` (`warpQuad` `:49`)
- Enhance (off): `lib/scanPipeline/web/cv/enhance.ts` (`enhanceMat` `:204`)
- Build scripts: `scripts/opencv-assets.mjs`, `scripts/copy-opencv-assets.mjs`, `scripts/build-cv-worker.mjs`

Line numbers as of 2026-11-25; search for the symbol name if one has moved.

## Learn more
- OpenCV.js tutorials (official): https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html
- `@techstark/opencv-js` on npm: https://www.npmjs.com/package/@techstark/opencv-js
- MDN, Using Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- MDN, `importScripts`: https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts
- MDN, `createImageBitmap`: https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
