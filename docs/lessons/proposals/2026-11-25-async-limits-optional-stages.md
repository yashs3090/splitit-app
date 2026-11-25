# Proposal: every outside await has a time limit, and optional stages fall back instead of failing

**Status: applied 2026-11-25** (both changes applied exactly as written)

**Targets:** `.claude/agents/implementer.md` (How to work); `.claude/agents/code-reviewer.md` (What to look for, item 3)

**Promotion rule used:** a lesson in the same area seen twice or more becomes a rule in the agent that should have caught it. "Every async flow needs an ending for never-settles" is now at its fourth occurrence, and its rule lives only in `native-mobile` and `product-engineer`, while `implementer` wrote the code that broke it this time. "Heavy optional things behind a flag or lazy import" is at its second occurrence.

## Evidence (docs/lessons/log.md)
- 2026-11-21 "Every async flow needs a path for cancel, failure and sign-out" [expo].
- 2026-11-22 "App review: stale state, early optimism and lossy rollbacks" [expo].
- 2026-11-24 "Waiting for the refetch meant a failed refetch left the buttons stuck" [expo].
- 2026-11-25 "Optional stages failed the scan or threw away a good read" [expo]: Tesseract `recognize` stalls forever (30 s limit, S-4); a second-pass timeout discarded a good first read; `CvOpFailed` failed the scan; `esbuild` imported before the flag check.
- 2026-11-21 "Keep heavy web-only libraries behind one lazily imported module" [expo].

## Change 1: `.claude/agents/implementer.md`, How to work, new bullet after the "For navigation and auth flows…" bullet

Old:
```
- Follow the conventions in `CLAUDE.md`: integer cents, strict TypeScript, RLS on every table, no secrets in the app.
```

New:
```
- Every async flow has an ending for success, error, cancel and "never settles": resources are freed and the UI is re-enabled on each. Any await on something outside our control (an OCR engine, a worker, a fetch) has a time limit. A stage that is an optional improvement (crop, enhance, retry, a second pass) falls back to the best result so far when it fails or times out, and records why; only the required step may fail the whole flow. A timeout on a later pass never throws away an earlier pass's result. Optional heavy imports (build tools, big libraries) come after the flag or condition that needs them.
- Follow the conventions in `CLAUDE.md`: integer cents, strict TypeScript, RLS on every table, no secrets in the app.
```

## Change 2: `.claude/agents/code-reviewer.md`, item 3 (Correctness), append at the end of the item

Old:
```
Also flag money math from `lib/` that runs repeatedly per render instead of once per data change.
```

New:
```
Also flag money math from `lib/` that runs repeatedly per render instead of once per data change. For every async step, check its endings: an await on an outside engine, worker or fetch with no time limit; an optional stage whose error or timeout fails the whole flow instead of falling back; a later pass whose timeout discards an earlier good result; a heavy import that runs before the flag that needs it.
```

## What this changes for you
Scanning (and later features) shouldn't hang forever or fail outright because an extra step went wrong: you'd get the best read the app already had, plus a note in the scan's trace. Nothing visible changes today; these fixes are already in the code.
