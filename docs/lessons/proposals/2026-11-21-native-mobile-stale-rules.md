# Proposal: native-mobile: fix the stale web rule and the install-and-pin rule

**Status:** applied 2026-11-21 (all three changes, including the optional Change 3)
**Target file:** `.claude/agents/native-mobile.md` § Rules
**Promotion rule used:** "A rule that caused a wrong result gets a proposal to delete or reword it" (retro SKILL.md §2).
- "Add packages with `npx expo install`, never bare `npm install`" left `^` ranges on packages the spec said to pin exactly (`expo-mlkit-ocr`, `tesseract.js`). The implementer had to re-pin with `npm i -E`.
- "Web has no on-device recognition: the web path is manual entry" has been false since Amendment A3 (web reads receipts with Tesseract.js, ADR 0012). An agent following it would refuse or undo web scanning.

## Exact change

### Change 1

Old:
```
- Add packages with `npx expo install`, never bare `npm install`, for anything Expo-related.
```

New:
```
- Add Expo SDK packages with `npx expo install` so versions match the SDK. For a third-party package the spec says to pin exactly, `expo install` still saves a `^` range: re-pin with `npm i -E <pkg>@<version>` and check `package.json` shows the bare version. Report the exact versions installed.
```

### Change 2

Old:
```
- Web has no on-device recognition: the web path is manual entry, and must not import native-only modules.
```

New:
```
- Web reads receipts in the browser with Tesseract.js (provisional, ADR 0012), and manual entry is always available. Web files never import native-only modules (`expo-mlkit-ocr`, `expo-file-system`), and native files never import `tesseract.js`. Heavy web-only libraries live in one module reached only through `await import()` (like `lib/webOcrEngine.ts`); check the entry bundle after `npm run export:web`.
```

### Change 3: new rule, after "Every `Platform.OS` branch gets a test per branch"

Old:
```
- Every `Platform.OS` branch gets a test per branch (lessons log).
```

New:
```
- Every `Platform.OS` branch gets a test per branch (lessons log).
- Every async flow (capture, recognition, worker start-up) has a defined end for success, error, cancel/abort and "never settles": resources are freed and the UI is re-enabled on each. Don't depend on browser events that aren't supported everywhere (e.g. the file input's `cancel`). Per-user state such as scan results is cleared on sign-out.
```

## Evidence (docs/lessons/log.md)
- "2026-11-21: `npx expo install` writes `^` ranges for non-Expo packages [area: expo]"
- "2026-11-21: Keep heavy web-only libraries behind one lazily imported module [area: expo]"
- "2026-11-21: Every async flow needs a path for cancel, failure and sign-out [area: expo]" (first occurrence; Change 3 is optional and can wait for a repeat)
- Spec `docs/specs/2026-11-20-m1a-scan-receipt.md`: Amendment A3; `package.json` (`"expo-mlkit-ocr": "0.2.7"`, `"tesseract.js": "7.0.0"`).
