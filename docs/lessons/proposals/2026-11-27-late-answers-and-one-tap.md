# Proposal: a timed-out write is "outcome unknown", and actions run one at a time

**Status: pending**

**Targets:** `.claude/agents/implementer.md` (§ How to work, the async-endings bullet); `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/code-reviewer.md` (item 3, Correctness)

**Promotion rule used:** same lesson twice or more in the log (expo area). The async-endings lesson is at its eighth occurrence, and the applied 2026-11-25 rule ("any await … has a time limit") didn't stop round 2 of Who paid: a time limit stops waiting, but the write keeps going. Repeated taps getting through is at its fourth occurrence; the 2026-11-27 entry said to promote it if it recurred, and it did in the next task.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "Async endings, eighth time: no time limit on the page, and a timed-out write could commit late" [expo]: Who paid review round 1 R5 (no time limit on the page's fetch and save), round 2 R1 (`within` doesn't cancel; the late answer was unhandled) and R2 (`clearLateSend` had no limit and no message).
- 2026-11-27 "A double tap sent two saves and two `router.back()`s, and a push had no guard" [expo]: round 1 R4 and R8.
- 2026-11-27 "Group refetches could be superseded, and group calls had no time limit" [expo]: GR-RV-2 answered a timeout safely with client-id idempotency, which is the pattern this proposal writes down.
- 2026-11-27 "Copy said 'paid' for a send, and Settle was pushed twice" [expo]; 2026-11-24 "Waiting for the refetch meant a failed refetch left the buttons stuck" [expo] (R7, no double-tap guard on Pay).
- Earlier async entries: 2026-11-21, 2026-11-22, 2026-11-24, 2026-11-25 "Optional stages failed the scan…", 2026-11-27 "After Venmo opened…".

## Change 1: `.claude/agents/implementer.md`, § How to work, appended to the end of the "Every async flow has an ending…" bullet

Old:
```
Optional heavy imports (build tools, big libraries) come after the flag or condition that needs them.
```

New:
```
Optional heavy imports (build tools, big libraries) come after the flag or condition that needs them. A time limit stops the wait, not the request: a write that timed out may still commit, so treat it as "outcome unknown". Say it may have saved, refetch before allowing a retry (or make the retry idempotent with a client id), and catch the late answer so it only triggers that refetch, never an unhandled rejection or a second write. Clean-up and background calls get the same limit and a message when they fail. Test with a fake that answers after the timeout. Any control that writes or navigates ignores repeat taps while its action is in flight (a ref set synchronously, not only React state), with a test that taps twice in the same tick and expects one call and one navigation.
```

## Change 2: `.claude/agents/product-engineer.md`, § Build, new bullet directly before "Only the root layout's resume effect navigates after sign-in." (after any bullets the pending refetch proposal inserts there)

Old:
```
- Only the root layout's resume effect navigates after sign-in. Screens don't hard-redirect once a session exists.
```
(Insert the bullet directly before this line; the line itself stays unchanged.)

New (inserted):
```
- Timeouts and repeat taps. Every fetch and write has a time limit, and Back is never stuck behind one. A time limit stops the wait, not the request: a write that timed out may still commit, so the screen says it may have saved and refetches before allowing a retry (or the retry is idempotent with a client id), and the late answer is caught and only triggers that refetch. Clean-up and background calls (clearing a late send, marking seen) get the same limit and a message when they fail. Any control that writes or navigates (Save, a confirm, `router.push`, `router.back`) ignores repeat taps while its action is in flight, using a ref set synchronously. Test each: a fake that answers after the timeout, and two taps in the same tick (one call, one navigation).
```

## Change 3: `.claude/agents/code-reviewer.md`, item 3, appended after "…a heavy import that runs before the flag that needs it."

(If the pending refetch proposal's Change 3b or 4b is applied first, put this after the sentences they add.)

Old:
```
a heavy import that runs before the flag that needs it.
```

New:
```
a heavy import that runs before the flag that needs it. For every write with a time limit, ask what happens if the answer arrives after the timeout (it can: the request isn't cancelled), and flag a late answer that's unhandled, writes again, or leaves the screen saying "failed" for something that saved. Flag clean-up calls with no limit or message, and any control that writes or navigates without a synchronous repeat-tap guard.
```

## More evidence and one added sentence (2026-11-28, tab-bar-and-Activity retro)

Evidence: log 2026-11-28 "Feed reads raced: a loadMore during a refresh, and badge reloads on every bill version" [expo]. Review R2 of docs/specs/2026-11-28-tab-bar-and-activity.md: a next-page read that answered during a refresh landed on the new list and left a gap. R4: badges reloaded on every bill version change (now debounced by 2 s). This is the read-side version of a late answer, the same family as 2026-11-27 "Group refetches could be superseded…".

Add this sentence to the end of Change 1's and Change 2's new text:
```
In a paged list, a refresh supersedes any next-page read still in flight (a generation counter), and an answer from an older generation is dropped. Reloads triggered by realtime or version changes are debounced. Test a next page that answers after a refresh has started.
```

## Compatibility
- Change 3a of the pending `2026-11-24-product-engineer-refetch-and-copy.md` copies the general async-endings rule into `product-engineer`. Change 2 here is narrower (late answers and repeat taps) and stands alone, so it can be applied first. If both are applied, they sit next to each other and don't contradict.

## What this changes for you
A slow network can't make SplitIt save twice or tell you something failed when it actually saved, and a quick double tap does one thing, once.
