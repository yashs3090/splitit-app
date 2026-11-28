# Proposal: CLAUDE.md's leak-check note names both expected `cdn.jsdelivr.net` matches

**Status: pending**

**Target:** `CLAUDE.md` § Commands, the Web build bullet

**Promotion rule used:** a rule that gives a wrong answer gets reworded. The note says one match is expected, but a correct build has two files with it, so every QA run has to decide again whether the second one is a leak.

## Evidence (docs/lessons/log.md)
- 2026-11-26 "CLAUDE.md's leak-check note lists one expected `cdn.jsdelivr.net` match, but the build has two files with it" [testing]. QA of docs/specs/2026-11-26-home-mobile-refresh.md found it in `dist/tesseract/worker.min.js`. Checked in the current `dist/`: one line in `_expo/static/js/web/webOcrEngine-*.js` and one line in `tesseract/worker.min.js`. The worker's line holds Tesseract's default core and language-data URLs (`cdn.jsdelivr.net/npm/tesseract.js-core@v…`, `cdn.jsdelivr.net/npm/@tesseract.js-data/…`), unused because `lib/webOcrEngine.ts` passes self-hosted `workerPath`, `corePath` and `langPath`. The worker file reaches `dist/` through the `preexport:web` asset-copy hook, which came after the note was written.

## Change: `CLAUDE.md` § Commands, Web build bullet

Old:
```
One `cdn.jsdelivr.net` match inside the lazy `webOcrEngine-*` chunk is expected (Tesseract.js's unused default path; ADR 0012).
```

New:
```
`cdn.jsdelivr.net` is expected on one line in each of two files: the lazy `webOcrEngine-*` chunk and the self-hosted `dist/tesseract/worker.min.js` (Tesseract.js's unused default paths; we pass self-hosted `workerPath`, `corePath` and `langPath`; ADR 0012). A match in any other file is a finding.
```

**Order with other pending proposals:** Change 2 of `2026-11-24-bundle-checks-jest-setup-tracked-items.md` uses the old sentence as its anchor and keeps it, adding sentences after it. If this proposal is applied first, use the new sentence above as that change's anchor, and keep it as is in its new text.

## What this changes for you
QA will stop reporting the Tesseract worker's built-in CDN address as a possible leak, and a match anywhere else will stand out.
