# Proposal: "visual" changes that quietly change behavior (semantics, identity, exit paths), and no whole-file formatting

**Status: pending**

**Targets:** `.claude/agents/visual-designer.md` (How you work); `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/code-reviewer.md` (item 3, Correctness); `.claude/agents/implementer.md` (How to work)

**Promotion rules used:**
- Heading roles lost in a restyle: seen twice in this pass (review 1 nit, review 2 should-fix), plus the 2026-11-22 accessibility-label lesson in the same family.
- Unsaved input lost through an exit path the guard didn't cover: seen twice in this pass (P13 system back paths; the iOS sheet swipe-down in round 3), and it is the "list how it ends" lesson (2026-11-21) applied to screens.
- SharePanel remount and the Prettier rewrite are first occurrences. They're included because the `visual-designer` agent is new and was written without evidence, and because the Prettier rewrite can't be undone on an untracked file. Changes 1(2) and 4/5 can be rejected separately if you'd rather wait for a second occurrence.

## Evidence (docs/lessons/log.md)
- 2026-11-25 "A layout change remounted SharePanel and threw away what the host had typed" [expo]
- 2026-11-25 "Restyles dropped heading roles, twice in one pass" [expo]
- 2026-11-25 "Native headers and sheets added ways to leave that skip the 'discard?' check" [expo]
- 2026-11-25 "The designer ran Prettier over a whole untracked file, with no way to restore it" [process]
- 2026-11-22 "A row's screen-reader label hid its price and status" [expo]
- 2026-11-21 "Every async flow needs a path for cancel, failure and sign-out" [expo]
- 2026-11-19 "Agents don't write .env or break code on disk; use inline env vars" [testing]

## Change 1: `.claude/agents/visual-designer.md`, How you work, the "Visual only" bullet

Old:
```
- **Visual only.** Never change behavior, copy meaning, navigation, data flow, money math or accessibility semantics. If a screen needs a behavior or copy change to look right, stop and report it as a proposal. Copy tweaks for clarity are proposals too, unless the task says otherwise.
```

New:
```
- **Visual only.** Never change behavior, copy meaning, navigation, data flow, money math or accessibility semantics. If a screen needs a behavior or copy change to look right, stop and report it as a proposal. Copy tweaks for clarity are proposals too, unless the task says otherwise. Three kinds of "visual" change alter behavior without looking like it; check each one every time:
  1. **Semantics.** Before and after restyling an element, compare its `accessibilityRole`, label, hint and state. A heading moved onto a primitive keeps `accessibilityRole="header"` (or the primitive sets it), and each screen still has exactly one heading after its title moves into a native header.
  2. **Identity.** A component that holds state and moves depending on data (above the items while the host is alone, below once someone joins) renders in one place with a stable `key` (for example a keyed array whose order changes). Two conditional slots remount it and lose what was typed. Test the move with state in it.
  3. **Exit paths.** A native header or sheet adds ways to leave (iOS back-swipe or swipe-down, Android back, browser back). If the screen holds unsaved input, each one keeps the screen's discard guard, or you report the gap as a proposal.
```

## Change 2: `.claude/agents/visual-designer.md`, How you work, the last bullet

Old:
```
- Never read or edit `.env*` files. Don't commit or push. Don't restart a dev server someone else started.
```

New:
```
- Never read or edit `.env*` files. Don't commit or push. Don't restart a dev server someone else started; if you added a package, say "dev server needs a restart" in your report.
- Don't run Prettier, `eslint --fix` or codemods over files: the project has no formatter config, and many files are untracked, so a whole-file rewrite can't be undone and hides your real change from review. Edit only the lines you change, in the file's existing style.
```

## Change 3: `.claude/agents/product-engineer.md`, § Build, new bullet directly before the "Accessibility:" bullet

Old:
```
- Accessibility: every interactive element has `accessibilityRole` and `accessibilityLabel`,
```
(Insert the bullet directly before this line; the line itself stays unchanged. This doesn't touch the lines the pending `2026-11-24-product-engineer-refetch-and-copy.md` inserts before "Only the root layout's resume effect…".)

New (inserted):
```
- A screen or sheet that holds unsaved input lists every way it can close: its own button, iOS back-swipe or swipe-down, Android back, browser back, tapping the scrim. Each one keeps the discard guard (or saves), or the plan says why not; test the ones the platform lets you test. Moving a screen to a native header or sheet adds these paths.
```

## Change 4: `.claude/agents/code-reviewer.md`, item 3 (Correctness), two sentences added at the end of the item

Old:
```
a heavy import that runs before the flag that needs it.
```

New:
```
a heavy import that runs before the flag that needs it. For a screen or sheet with unsaved input, check that every way it can close (its button, iOS back-swipe or swipe-down, Android back, browser back, the scrim) keeps the discard guard or is a recorded exception; a change to a native header or sheet adds these paths. When a component that holds state renders in different places depending on data, check it keeps its identity (one slot with a stable `key`) instead of remounting, and that restyled headings keep their heading role.
```
(This appends to the item's last sentence. It doesn't overlap the pending `2026-11-24-lock-order-implicit-locks.md`, which anchors on the "Also flag money math…" sentence.)

## Change 5: `.claude/agents/implementer.md`, How to work, the last bullet

Old:
```
- Don't commit or push.
```

New:
```
- Don't commit or push. Don't run Prettier, `eslint --fix` or codemods over files (there's no project formatter config, and untracked files can't be restored); edit only the lines the task changes.
```

## What this changes for you
Restyles stop costing screen-reader users their headings, a block that moves on screen keeps whatever someone had typed in it, and switching to native back buttons and sheets can't open a new way to lose an unsaved bill or split without someone noticing. Agents also stop reformatting whole files you haven't committed yet.
