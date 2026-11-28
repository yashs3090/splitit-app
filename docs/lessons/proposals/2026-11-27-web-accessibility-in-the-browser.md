# Proposal: check web accessibility in the browser, with the keyboard, and at 200% zoom

**Status: pending**

**Targets:** `.claude/agents/product-engineer.md` (§ Build, the "Accessibility:" bullet); `.claude/agents/qa-tester.md` (step 3, new sub-bullet); added 2026-11-27 (Home groups v2 retro): `.claude/agents/product-manager.md`, `.claude/agents/visual-designer.md`, `.claude/agents/code-reviewer.md` (Changes 3–5)

**Promotion rules used:** same lesson twice or more (expo area).
- A react-native-web behavior was assumed for the second time. The first was 2026-11-25 "On web, the focus ring showed on mouse clicks and taps" (`onFocus` fires for every focus). Now it's QA F1, where `accessibilityState` isn't mapped to ARIA.
- New panels overflowed at 200% zoom twice in one task (QA F2, then N1).
- A custom radio group lacked its keyboard pattern (N2). This ships with the rest because it's the same check: what a keyboard or screen-reader user gets on web.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "Web accessibility was checked in Jest, but react-native-web ignores `accessibilityState`" [expo]:
  - QA F1: the web radios had no `aria-checked`, while the Jest test passed because the test renderer reads `accessibilityState`.
  - Re-check N2: no Space or arrow-key selection.
  - The copy fix: "On a computer?" was showing on mobile web.
  - The fix is in `components/ui/SegmentedControl.tsx` (header comment: aria-* on web, roving tabindex, arrow keys).
- 2026-11-27 "Two new panels overflowed at 200% zoom" [expo]: QA F2 (the Not received confirm) and N1 (the chooser).
- 2026-11-25 "On web, the focus ring showed on mouse clicks and taps" [expo].
- All three are in docs/specs/2026-11-26-sent-via-venmo.md.

## Change 1: `.claude/agents/product-engineer.md`, § Build, the "Accessibility:" bullet, sentences added at the end

Old:
```
A custom label on a row or card says everything the row shows that matters.
```

New:
```
A custom label on a row or card says everything the row shows that matters. On web, react-native-web doesn't turn `accessibilityState` into ARIA, so state that matters on web goes out as the `aria-*` props it does map (`aria-checked`, `aria-pressed`, `aria-disabled`, `aria-expanded`), and a Jest test of `accessibilityState` doesn't count as proof for web. Custom radio groups and tab sets follow the WAI-ARIA keyboard pattern: one tab stop, arrow keys move the selection, Space selects. Copy meant for desktop only is gated on `detectMobileWeb` (`lib/appBanner.ts`), not on `Platform.OS === 'web'`. Rows of controls and confirms wrap or stack at 200% browser zoom and at the largest Dynamic Type size, with nothing clipped and no sideways scrolling.
```

## Change 2: `.claude/agents/qa-tester.md`, step 3, new sub-bullet directly after the "Prints nothing" bullet

New (inserted):
```
   - **Web accessibility is checked in the browser.** For each new or changed control on web, read its role and state in the running page's DOM (for example `aria-checked`, `aria-disabled`, `role`), not only in Jest: the Jest renderer reads `accessibilityState`, and react-native-web doesn't output it. Go through the new UI with the keyboard alone (Tab, arrow keys, Space, Enter), and view every new panel at 200% browser zoom (or a 320 px wide window) and on a narrow phone width. Report anything clipped, overlapping, scrolling sideways or not reachable by keyboard.
```

## Not part of this proposal: a possible follow-up for the backlog
23 files under `app/` and `components/` use `accessibilityState` (Grep count, 2026-11-27). The primitives `Button`, `IconButton`, `TextLink`, `DisclosureRow` and `BackHeader` may have the same web gap for `disabled`, `selected` or `expanded` unless they already pass `aria-*`. A one-time audit would settle it. It's your call whether to add it to `docs/backlog.md`.

## Changes 3–5 (added 2026-11-27, Home groups v2 retro)

Evidence: log 2026-11-27 "react-native-web dropped `accessibilityState` again, this time because the spec prescribed it" [expo]. Review R1 of docs/specs/2026-11-26-home-groups-v2.md: `DisclosureRow` had no `aria-expanded` on web. The follow-up note above predicted this. The spec's D7 (line 209) told the builder to use `accessibilityState={{ expanded: open }}` and `accessibilityHint`, and react-native-web 0.21 drops both. This is the third react-native-web assumption. It recurred one task after this proposal was written, because the proposal doesn't reach the agents who write the props into the spec (PM, visual-designer) or the one who reviews them. The fix's test renders through react-native-web with `react-dom/server`. That pattern is now hand-copied in `__tests__/assignChips.test.tsx`, `billGroup.test.tsx`, `groupAriaWeb.test.tsx` and `uiPrimitives.test.tsx` (twice). There are also two ways of passing the props: `lib/ariaProps.ts` (the groups session) and inline props in `DisclosureRow`.

More evidence (added 2026-11-27, group claim status retro): log 2026-11-27 "The 'I wasn't part of this' hint doesn't reach web, a decided departure (GCS-15)" [expo]. The opt-out's reassurance ("It doesn't change anyone's share") is only an `accessibilityHint`, so web screen readers never hear it. It was logged as a decision this time, not missed, but the reworded Change 1's "anything the hint says that a web user needs goes in the label" would have settled it. This is the fourth react-native-web case.

**Change 1, reworded.** Apply this text instead of Change 1's "New" above. It adds the hint and the helper.
```
A custom label on a row or card says everything the row shows that matters. On web, react-native-web 0.21 drops `accessibilityState` and `accessibilityHint`. State that matters on web goes out as `aria-*` props (`aria-checked`, `aria-pressed`, `aria-disabled`, `aria-expanded`, `aria-hidden`), preferably through `ariaProps(state)` from `lib/ariaProps.ts`. Anything the hint says that a web user needs goes in the label. A Jest test of `accessibilityState` doesn't count as proof for web: check the attributes in a react-native-web static-markup render (`renderToStaticMarkup`, as in `__tests__/groupAriaWeb.test.tsx`). Custom radio groups and tab sets follow the WAI-ARIA keyboard pattern: one tab stop, arrow keys move the selection, Space selects. Copy meant for desktop only is gated on `detectMobileWeb` (`lib/appBanner.ts`), not on `Platform.OS === 'web'`. Rows of controls and confirms wrap or stack at 200% browser zoom and at the largest Dynamic Type size, with nothing clipped and no sideways scrolling.
```

**Change 3: `.claude/agents/product-manager.md`, Rules, end of the "Tool facts are verified or marked." bullet** (after the sentence the pending `2026-11-24-pm-library-shapes-reachability-state-table.md` Change 1 adds, if that's applied first)

Old:
```
Tunable parameters are "starting value"; the implementer may change them with evidence.
```

New:
```
Tunable parameters are "starting value"; the implementer may change them with evidence. Accessibility props written into a spec for a control that runs on web name the `aria-*` prop (or `ariaProps(...)` from `lib/ariaProps.ts`) alongside `accessibilityState`, because react-native-web drops `accessibilityState` and `accessibilityHint`. Don't copy "the same pattern as <component>" without checking that the component's pattern works on web.
```

**Change 4: `.claude/agents/visual-designer.md`, the "Accessibility stays intact" bullet**

Old:
```
- **Accessibility stays intact:** touch targets ≥ 44, Dynamic Type (text grows; layouts wrap instead of clipping), web keyboard focus visible, reduced-motion respected.
```

New:
```
- **Accessibility stays intact:** touch targets ≥ 44, Dynamic Type (text grows; layouts wrap instead of clipping), web keyboard focus visible, reduced-motion respected. On web, react-native-web drops `accessibilityState` and `accessibilityHint`, so a control you design or restyle carries its state as `aria-*` props (`lib/ariaProps.ts`); check it in a react-native-web static-markup render. New panels are checked at 200% browser zoom.
```

**Change 5: `.claude/agents/code-reviewer.md`, item 4 (Tests), end of the first sentence**

Old:
```
acceptance criteria with no test; tests that don't actually assert the behavior.
```

New:
```
acceptance criteria with no test; tests that don't actually assert the behavior. For a control that runs on web, flag state passed only through `accessibilityState` or meaning carried only by `accessibilityHint` (react-native-web drops both), and a web-semantics test that reads `accessibilityState` from the RN test renderer instead of a react-native-web static-markup render.
```
(This edits the same sentence as Change 4 of `2026-11-25-absence-assertions-need-presence.md`. Whichever is applied second keeps the other's added text and adds its own after it.)

**Not part of this proposal (a small code task for the backlog):** move the static-markup render into one helper, `test-utils/webMarkup.ts`. It would take the component factory and return the tag for a label, as `webTag` does in `__tests__/groupAriaWeb.test.tsx`. Then point the four test files at it, and fix `components/SharesSummary.tsx` (already tracked in `docs/before-production.md` §7). Once the helper exists, Changes 1 and 4 should name it instead of `groupAriaWeb.test.tsx`.

## More evidence and one added sentence (2026-11-28, tab-bar-and-Activity retro)

Evidence: log 2026-11-28 "Web keyboard failures again: chips lost focus, tabs ignored Enter/Space, the narrow bar overlapped" [expo]. QA of docs/specs/2026-11-28-tab-bar-and-activity.md failed on three web checks, all found in the browser and none in Jest:
- the Activity chips lost keyboard focus, because react-native-web's `ScrollView` rebuilt its tree when `RefreshControl` was added or removed;
- tab bar items had `role=link` without an `href`, so Enter and Space did nothing;
- the bar overlapped below about 300 px, and is now a compact bar (FEED-47).

These are the fifth and sixth react-native-web cases and the third narrow-width overlap. QA's browser check (Change 2 here) is what caught them, which is evidence that it works.

Add this sentence to the end of the reworded Change 1 text (after "…with nothing clipped and no sideways scrolling."):
```
On web, keep a focusable control's tree stable across state changes: don't add or remove a wrapper prop such as `RefreshControl` (render it always and toggle `refreshing`), or react-native-web rebuilds the subtree and focus is lost. A control with `role="link"` has an `href`; otherwise it uses the button role, or Enter and Space do nothing.
```

## What this changes for you
Keyboard and screen-reader users on web, and anyone with browser zoom turned up, get checked for before QA rather than found in QA. A passing Jest test no longer stands in for what the browser really exposes. With Changes 3–5, the spec and design won't tell the builder to use props the browser never sees, and the reviewer will catch it if they do.
