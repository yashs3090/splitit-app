# Home groups v2: Waiting on you, Owed to you, Settled, and hidden

Date: 2026-11-26. Repo: `splitit-app` only (ADR 0011). No migration, no `supabase/` change, no ADR: every rule here is client-side and easy to reverse.
Builds on `docs/specs/2026-11-26-home-mobile-refresh.md` (built, QA-passed, uncommitted). That spec's D1 (sticky bar), D2 (row content), D3 (row amount), D5 (row label) and D6 (people counts) stay as they are. **D4 (sections) is replaced** by D1–D5 below. Coordinated with the Sent-via-Venmo session (splitit-app-92), `docs/specs/2026-11-26-sent-via-venmo.md` and its `-ux` / `-visual` docs (see "Dependencies").

The user prefers PM-level choices decided and logged. They are logged as **GV-1 to GV-20** in `docs/decisions-to-review.md` ("2026-11-26 · Home groups v2"). Two questions need the user. Neither blocks a task (see "Questions for the user").

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already set up) | User check U1 (real bills, two accounts on web) | $0 |
| Two Google test accounts (exist) | U1, U2 | $0 |
| Anything new (service, account, package, migration) | **Not needed** | $0 |

Nothing new to sign up for.

## Goal
Home tells each person what's open between them and other people, in money terms. **Waiting on you** lists bills where you still have to pay someone (or can't yet but will). **Owed to you** lists bills where someone still owes you. **Settled** is a collapsed list of your bills that everyone has paid. Bills where you've paid your share disappear, and come back the moment your money on them changes.

## The user's rules (2026-11-26, binding)
1. **Waiting on you** (heading unchanged): bills where the viewer has to pay someone. That covers new bills, nothing claimed yet, "You owe", "paid but the amount went up", "not received", and **new:** "claimed, but can't pay yet", shown with a muted pill.
2. **Owed to you** (exact heading): bills where the viewer is the payer and someone still owes them. This uses the payer, not the host. 92's `sent` pill ("Sam sent you $15.10") lands here.
3. **Settled** (exact heading): collapsed by default, with a count, and expands when tapped. It holds **only** bills where the viewer is the payer and everyone has paid.
4. **Hidden:** guest bills where the viewer has fully paid their share, even if others haven't. They come back if the viewer's amount becomes non-zero again.
5. **"Recent" is removed.** Every bill lands in exactly one group, or is hidden.
6. **Clarification (binding):** hidden and Settled hold only while the viewer's outstanding amount is zero **in both directions**. A change that makes the viewer owe more brings the bill back to Waiting on you. A change that makes the payer owed again (a share went up, a new person claimed, an edit reopened the bill) moves it from Settled back to Owed to you. This is read from the plan's amounts, not from a one-time "marked paid" flag.
7. **Group by what's owed; markers decide only the pill** (the user, 2026-11-26, reversing the earlier marker-first rule): "after Sam pays it should move out, since she isn't owed for the bill anymore. It will show up in her activity (Sam paid) and in her past completed bills." A payer's bill moves to Settled as soon as nobody owes them, even with an unseen `sent` update. 92's `billMarker` returns `sent` only while someone still owes the payer, and `settled` otherwise. Settled has no pinned rows and no "1 update" handling.
8. **Future-proofing (backlog item 4: changing the payer, several payers):** groups are defined by the viewer's outstanding amounts (owed to them > 0, they owe > 0, both 0). Every "is the viewer the payer" check sits in one helper.

## In scope
- `lib/homeSections.ts`: the viewer's balance on a bill (D1), the group rule (D2, D3), the marker/group consistency record (D4), the sections split and empty-state facts (D5), copy.
- `app/(app)/index.tsx` plus a new `components/SettledToggle.tsx`: render the three groups, the collapsed Settled disclosure, and the "all caught up" card (D6, D7).
- Docs.

## Out of scope (cut)
- Any migration, `supabase/` change, or new read. Settle data Home already loads covers every bill that needs it (D8).
- A way to reach a hidden bill from Home (Q1 asks the user).
- Changes to the pills' words or tones, including H2's early "Paid $X" (dependency D-2).
- Remembering the Settled open/closed state across launches (GV-11).
- Hands off: `vercel.json`, `app.json`, `app.config.ts`, `app/_layout.tsx`, `components/AppBanner.tsx`, `supabase/`, **`lib/homeMarkers.ts`** (owned by 92; new marker kinds go through them, D-1).

## Ownership and parallel work (read before starting)
- This slice owns `lib/homeSections.ts`, `lib/homeSections.test.ts`, `app/(app)/index.tsx`, `__tests__/homeLayout.test.tsx` and the Home-section assertions in `__tests__/homeMarkers.test.tsx`.
- **92's planned `lib/homeSections.ts` edits move into this slice.** 92 planned a `not_received` line in `WAITING_MARKERS` and `sent` / `not_received` fixtures. `WAITING_MARKERS` goes away here (GV-17), and Task 1 adds both kinds to the new record (D4) with fixtures. The main session tells 92 so it drops those edits.
- `git branch --show-current` and `git status` at the start and before the summary. Never run the full Jest suite at the same time as another session: use single files (`npx jest <file>`) or `npm test -- --maxWorkers=2`. A failure only in files this slice didn't touch is reported as outside the task.
- No formatter runs over files (no Prettier, no `eslint --fix`).

## Design

### D1. Shared contract: the viewer's balance on a bill (Task 1 defines it; D2 and every criterion use it)
Defined once in `lib/homeSections.ts`. Nothing else in `lib/`, `app/` or `components/` re-derives it.

```ts
/** The one "is the viewer the payer" check (rule 8). */
export function viewerIsPayer(summary: Pick<BillSummary, 'payerId'>, plan: SettlePlanWithEarly | undefined, myId: string): boolean;
export type ViewerBalance =
  | { known: false }
  | { known: true; final: boolean; owes: boolean; owed: boolean };
export function viewerBalance(summary: Pick<BillSummary, 'payerId'>, plan: SettlePlanWithEarly | undefined, myId: string): ViewerBalance;
```

**`viewerIsPayer`:** when `plan` is `ready` or `early`, `plan.payerId === myId` (the plan is the newer read). Otherwise `summary.payerId === myId`. This is the only place in `lib/homeSections.ts` that compares a payer id (criterion 9). A multi-payer change later rewrites this helper and the payer branch of `viewerBalance`, nothing else (Risk 5).

**`viewerBalance`:** `{ known: false }` when there's no plan, the plan's status is `blocked`, `blocked_all_zero` or `blocked_bad_payer`, or the viewer has no entry in `plan.people`. Otherwise `final = plan.status === 'ready'`, and `owes` / `owed` are booleans read off the entries. No sums, no arithmetic: each one is "is there at least one…".

`diff(e)` below is `differenceOf(e)` from `lib/settle.ts`, the same tolerance the pills use (`SETTLE_DIFF_IGNORE_CENTS`, 1¢, starting value owned by `lib/settle.ts`).

| Viewer | `owes` is true when | `owed` is true when |
|---|---|---|
| Not the payer (entry `me`) | `me.mark === null && me.role === 'owes'`, **or** `diff(me)?.kind === 'more'` | `diff(me)?.kind === 'back'` |
| The payer | some other entry `o` has `diff(o)?.kind === 'back'` (the payer owes a pay-back) | some other entry `o` has `o.mark === null && o.role === 'owes'`, **or** `diff(o)?.kind === 'more'` |

- **Not counted (GV-4):** an unmarked `payer_owes_them` share (a negative share, "Settle that outside the app"). The app can never record it as settled, so counting it would keep the bill open forever. A **marked** person whose share went negative still counts, through their `back` difference.
- **Early plans count as they are (GV-9).** In proportional mode the unclaimed items keep their weight, so others claiming doesn't move a share (`lib/split.ts`, `weights = [...personItems, unclaimedItemsCents]`). An early difference comes from a real change (an edit, a split, your own claims), and rule 6 says it brings the bill back.
- An early entry with `canSettle: false` and role `owes` still counts as `owes` (it can't pay yet, but it owes).

### D2. Shared contract: the group (Task 1 defines it; Task 2 renders it)
```ts
export type HomeGroup = 'waiting' | 'owed' | 'settled' | 'hidden';
export function homeGroup(input: {
  summary: Pick<BillSummary, 'payerId'>;
  plan: SettlePlanWithEarly | undefined;
  myId: string;
}): HomeGroup;
```
**The group comes only from the viewer's balance (D1) and role. Markers decide only the pill** (rule 7). `homeGroup` takes no marker, so it can't group on marker kinds or pill text. The marker and the group both read the same `plan`, and D4's record checks that they agree. First match wins:

| Step | Condition | Group |
|---|---|---|
| 1 | balance not known, viewer is the payer | `owed` |
| 2 | balance not known, viewer isn't the payer | `waiting` |
| 3 | `owed` (someone owes the viewer) | `owed` |
| 4 | `owes` (the viewer owes someone) | `waiting` |
| 5 | zero, viewer is the payer, `final` is false (early: still being claimed) | `owed` |
| 6 | zero, viewer is the payer, `final` | `settled` |
| 7 | zero, viewer isn't the payer | `hidden` |

- **Step 3 comes before step 4 (GV-2).** A payer who is owed by someone and also owes someone a pay-back goes to Owed to you. That matches the pill's own priority (the payer's "left to pay" or "differences" pill names collecting first), and the user's example: a new person claims on a settled bill, so they owe the payer while everyone else's share drops (pay-backs). It's "back to Owed to you". A guest can't be both at once.
- **No plan (steps 1–2).** `new` and `unclaimed` bills aren't settle candidates, so they never have a plan. A guest's `new` / `unclaimed` bill is Waiting by step 2. A payer who isn't the host and hasn't opened the bill (`new`) is Owed by step 1, with the accent "New" pill (GV-10).
- **Loading (steps 1–2, GV-5):** a bill whose settle read hasn't landed, or failed, has no plan. A guest's bill shows in Waiting on you with no pill, and a payer's in Owed to you. **A guest bill is hidden only once a plan confirms the zero balance, and a payer bill is Settled only once a `ready` plan confirms it.** Nothing is hidden or collapsed on a guess.
- **`sent` and Settled (rule 7):** once nobody owes the payer, the balance is zero and the bill is Settled at once. 92's marker is then `settled`, so the "Sam sent you $15.10" news isn't on Home. It's in Activity. While someone still owes, the bill is in Owed to you and can carry the `sent` pill.

### D3. The exhaustive table (criteria 12–17 test every reachable cell)
**Plan states, as Home sees them:**
- **N**: no plan, because the bill isn't a settle candidate (`settleCandidateIds` skips `new`, `unclaimed`, and payer bills that aren't complete).
- **L**: a candidate whose plan hasn't landed, whose read failed (HM-5 drops every plan), or whose plan couldn't be built. Home can't tell these apart, and they group the same.
- **B**: plan `blocked`, `blocked_all_zero` or `blocked_bad_payer`.
- **E**: plan `early`.
- **R**: plan `ready`.

"Guest" means any viewer who isn't the payer, including a host who made someone else the payer. "—" means the marker can't occur in that cell (reason given). **Waiting** = Waiting on you, **Owed** = Owed to you.

| Marker | Payer: N | Payer: L | Payer: B | Payer: E | Payer: R | Guest: N | Guest: L | Guest: B | Guest: E | Guest: R |
|---|---|---|---|---|---|---|---|---|---|---|
| `new` | Owed (GV-10; payer who isn't the host) | — (not a candidate) | — | — | — | Waiting | — (not a candidate) | — | — | — |
| `unclaimed` | — (never the payer) | — | — | — | — | Waiting | — (not a candidate) | — | — | — |
| `waiting_on_others` (D-1) | — (guests only) | — | — | — | — | — (needs a plan) | — | Waiting | — (B only) | — |
| `not_received` (92) | — (guests only) | — | — | — | — | — (needs a plan) | — | — | Waiting | Waiting |
| `owes` | — | — | — | — | — | — | — | — | Waiting | Waiting |
| `paid` | — | — | — | — | — | — | — | — | zero → **hidden**; `more` → Waiting; `back` → Owed (pill stays "Paid $X", D-2) | **hidden** (a `paid` marker means no difference) |
| `paid_more` | — | — | — | — | — | — | — | — | — (R only) | Waiting |
| `paid_back_due` | — | — | — | — | — | — | — | — | — (R only) | Owed (GV-3) |
| `left_to_pay` | — | — | — | — (R only, HM-4) | Owed | — | — | — | — | — |
| `differences` | — | — | — | — (R only) | Owed if anyone owes the payer; else Waiting (pay-backs only) | — | — | — | — | — |
| `sent` (92) | — | — | — | Owed | Owed (92 returns `sent` only while someone owes; at zero the marker is `settled` and the group Settled) | — (payer only) | — | — | — | — |
| `settled` | — | — | — | — | **Settled** | — | — | — | — | — |
| none (`null`) | Owed (GV-6) | Owed (GV-5) | Owed (GV-6) | Owed | zero → **Settled** (GV-7) | — (a guest with no marker is always a candidate) | Waiting, no pill (GV-5) | Waiting, no pill (claimed nothing: host who isn't the payer) | `owes` → Waiting; zero → **hidden** (`nothing`, or an unmarked negative share, GV-4/GV-8) | zero → **hidden** (owes $0, GV-8); viewer missing from the plan → Waiting (GV-16) |

Notes on the table:
- Guest B with `claimedAny` true and no marker: today there's no pill (it's Waiting with no pill). With D-1 it gets `waiting_on_others`. The group is the same either way, so D-1 can land before or after Task 1.
- Payer R with no marker and zero balance happens when nobody owes the payer anything (a "Just you" bill that's fully claimed, or everyone else's share is $0). GV-7 puts it in Settled: "everyone has paid" holds, and anything else would leave it in Owed to you with nothing owed.
- `left_to_pay` with a pay-back also owed (GV-2) goes to Owed. So does `differences` with someone still owing.

**Coming back (rule 6), the transitions criterion 17 tests:**

| Start | Change | Plan after | Marker after | Group after |
|---|---|---|---|---|
| Guest hidden (ready, marked 1480 = share) | share goes to 1620 (an edit, or tax or tip changed) | R | `paid_more` | Waiting |
| same | share goes to 1400 | R | `paid_back_due` | Owed |
| same | a new item, the bill now incomplete, share unchanged | E | `paid` | hidden |
| same | a new item and the share goes to 1620 | E | `paid` | Waiting |
| same | an even-split bill gets a new unclaimed item | B | none (`waiting_on_others` with D-1) | Waiting |
| Guest Waiting (`paid_more`) | they pay the difference (mark becomes 1620) | R | `paid` | hidden (back to zero) |
| Payer Settled (ready, all marked, no difference) | one person's share goes up | R | `differences` (`more`) | Owed |
| same | a new person joins and claims an item | R | `left_to_pay` (or `differences` in 92's order) | Owed |
| same | a new person joins and claims nothing | R | `settled` | Settled (no money changed) |
| same | the host adds an item, so the bill is incomplete | N (or E once 92 removes the HM-4 skip) | none | Owed |
| same | one share drops, so the payer owes a pay-back | R | `differences` (`back`) | Waiting |
| Payer Owed (`differences`, `more`) | the difference is paid | R | `settled` | Settled (back to zero) |
| Payer Owed (`left_to_pay`, Sam the last one unpaid) | Sam marks paid (any method; 92's unseen update) | R | `settled` (92: `sent` only while someone owes) | **Settled at once** (rule 7); the news is in Activity |
| Payer Owed (two unpaid) | one of them marks paid | R | `sent` (92) or `left_to_pay` | Owed (someone still owes) |

### D4. Shared contract: the marker/group consistency record (Task 1; criteria 19–21)
The group never reads the marker (D2). This record states, for every marker kind, which groups its pill may appear in. Tests use it (criterion 21) to prove that the pill and the group, both read from one plan, can't disagree.
```ts
export const MARKER_GROUPS: Readonly<Record<HomeMarker, readonly HomeGroup[]>> = {
  new: ['waiting', 'owed'],          // guest: no plan → waiting; payer who isn't host → owed
  unclaimed: ['waiting'],
  not_received: ['waiting'],         // 92: unmarked, owes
  owes: ['waiting'],
  paid: ['hidden', 'waiting', 'owed'], // ready → hidden; early with a difference → waiting / owed (D-2)
  paid_more: ['waiting'],
  paid_back_due: ['owed'],
  left_to_pay: ['owed'],
  differences: ['owed', 'waiting'],  // owed when anyone owes the payer; waiting for pay-backs only
  sent: ['owed'],                    // 92: only while someone owes
  settled: ['settled'],
};
```
- No marker is ever on a `hidden` row except `paid`, and `hidden` rows aren't drawn anyway.
- It's typed `Record<HomeMarker, …>`, so **adding a `HomeMarker` kind fails `npm run typecheck`** until the kind gets an entry. That replaces today's hand-written `ALL_MARKERS` list, which didn't fail when 92 grew the union (coordinator, 2026-11-26).
- `WAITING_MARKERS` and `isWaiting` are removed (GV-17). Grouping no longer goes through a marker set.
- Whoever adds a `HomeMarker` kind adds its line here, plus a fixture in `GROUP_FIXTURES` (criterion 19), in the same change. This slice pre-approves that one-line edit to `lib/homeSections.ts` and `lib/homeSections.test.ts` for the homeMarkers owner (D-1).
- In development builds (`__DEV__`), `homeRowView` may `console.warn` when a row's group isn't in `MARKER_GROUPS[marker]`. It never changes the group: the balance wins. Starting choice; the implementer may drop the warning if it's noisy in tests.

### D5. Shared contract: sections (Task 1; Task 2 renders)
- `HomeRowView` loses `waiting` and gains `group: HomeGroup`, computed as `homeGroup({ summary, plan: facts?.plan, myId })` inside `homeRowView`, from the same `plan` as `marker`, `pill` and `amount`.
- `homeSections(rows)` returns `{ waiting: R[]; owed: R[]; settled: R[]; hiddenCount: number }`. It's a stable partition in list order (HR-9), and `hidden` rows go only into the count.
- **Shape kept: rows in, sections out.** Home builds `rows = list.map(b => homeRowView(...))` and passes them to `homeSections`. Neither function filters by anything except the group. A later caller-side filter on the bill list (D6's Groups slot) is one line before `homeRowView`, with no change here.
- Copy (all in `lib/homeSections.ts`):

| Constant | Value |
|---|---|
| `HOME_SECTION_TITLES` | `{ waiting: 'Waiting on you', owed: 'Owed to you', settled: 'Settled' }` |
| `settledToggleText(n)` | `` `Settled (${n})` `` |
| `settledToggleA11y(n)` | `Settled, 1 bill` / `` `Settled, ${n} bills` `` |
| `HOME_COPY.settledShowHint` | `Shows bills everyone has paid you for` |
| `HOME_COPY.settledHideHint` | `Hides settled bills` |
| `HOME_COPY.allClear` | `You're all caught up.` |
| `HOME_COPY.hiddenNote` | `Bills you've paid don't show here.` |

### D6. Screen (Task 2)
Inside the scroll column, after the notice and the Venmo prompt, in this order:

| State | Home shows |
|---|---|
| loading / error / 0 bills | unchanged: "Your bills" + spinner / "Couldn't load your bills." + "Try again" / "No bills yet." |
| ready, ≥ 1 bill | 1. If Waiting and Owed are both empty: a `Card` with `allClear` in `type.body`, `textMuted`, plus `hiddenNote` in `type.caption` under it when `hiddenCount > 0`. No heading. 2. **Waiting on you** (`SectionHeader`, header role) + `Card flush` of rows, if non-empty. 3. **Owed to you**, the same way, if non-empty. 4. *(Reserved slot: Groups, see below. Nothing is rendered here in this slice.)* 5. The **Settled** toggle (D7) if `settled.length > 0`; when open, a `Card flush` of the settled rows under it |

**Layout order, fixed for later slices:** notice → Venmo prompt → all-caught-up card (only when 1 shows) → Waiting on you → Owed to you → **[Groups slot]** → Settled. The Groups MVP (splitit-app-52) will later put its own block, `components/GroupsSection.tsx`, in the slot between Owed to you and Settled. It will also drop group bills from the list before the rows are built, probably with a nullable `groupId` on `BillSummary`. In Home that's one line, `list.filter((b) => b.groupId == null)`, before `homeRowView`. Task 2 builds none of that. It leaves a comment `{/* Groups slot (splitit-app-52): between Owed to you and Settled */}` at that point in the JSX and keeps the sections in one keyed array, so a new key slots in. Open for 52 (not this slice): whether "You're all caught up." should still show when a group has balances.

- **All settled or hidden (rule 6 of the brief):** Home shows the "You're all caught up." card, then "Settled (5)", then the bottom bar. All hidden and none settled: the card with "Bills you've paid don't show here." and the bar. Home never shows a bare screen with bills on the server.
- "Your bills" appears only in loading, error and 0 bills (HR-10 kept). Section headings have no counts (HR-18 kept); only the Settled toggle shows one (user rule 3).
- One keyed list (`key` = `allClear` / `waiting` / `owed` / `settled`), so a section keeps its place in the tree when another one appears or goes.
- Unchanged: `BillRow` and `ListRow` (the role `link`, the hint `Opens this bill`, the D5 label, no tappable `trailing`), `MarkerPill` (two tones, no icon), the sticky bar ("Split a bill" header, one primary "Scan receipt", "Type items instead"), the notice and dismiss flow, focus and `AppState` refresh, `keepCandidates` (SE-UX-14 + R4), `keepListed`, and **Home never navigates by itself**.

### D7. The Settled toggle (Task 2; `components/SettledToggle.tsx`, new)
- Props: `{ count: number; open: boolean; onToggle: () => void }`. A `Pressable` with `accessibilityRole="button"`, `accessibilityLabel={settledToggleA11y(count)}`, `accessibilityState={{ expanded: open }}`, and `accessibilityHint` = `settledShowHint` when closed, `settledHideHint` when open. Same pattern as `components/SharesSummary.tsx`'s toggle (`useFocusRing`, pressed opacity).
- Look: the visible text `settledToggleText(count)` in `type.section`, `textMuted`, with SectionHeader's 4-pt inset, so it reads like the other headings. Then a 16-pt `ChevronRight` (closed) or `ChevronDown` (open) in `textMuted`, hidden from screen readers. Full column width, `minHeight: 44` (touch target ≥ 44 × 44). No fill, no teal (One Voice Rule; it isn't the next step).
- It's a button, not a header (GV-12): React Native gives an element one role, and the expanded state needs the button. Screen-reader users still reach it in reading order right after the last card.
- **State (GV-11):** `const [settledOpen, setSettledOpen] = useState(false)` in `HomeScreen`. Collapsed on every mount. It survives going to a bill and back (Home stays mounted under the stack) and focus refreshes. It isn't stored on the device. When the settled count drops to 0, the toggle unmounts and `settledOpen` resets to `false`, so it comes back collapsed.

### D8. Settle data coverage (no change)
- Settled needs a `ready` plan for every payer bill that could be settled. `settleCandidateIds` (`lib/homeMarkers.ts`) includes every bill whose marker without a plan is null, **except payer bills that aren't complete**. A payer bill that isn't complete can't be Settled (it's N → Owed in D3), so the skip loses nothing. Complete payer bills are candidates and get their plan from the same `fetchSettleData` read.
- Hidden needs a plan for every guest bill that could be paid up. Guests' `new` / `unclaimed` bills aren't candidates, and both are Waiting regardless. Every other guest bill is a candidate.
- Limits: `my_bills()` returns at most 20 bills, and `SETTLE_CANDIDATE_LIMIT` is 20, so every listed candidate is read. **No new read, no new column, no migration.** 92's Task 7 removes the HM-4 skip, which only turns payer N into payer E, still Owed.

### D9. Privacy, RLS and money
- No new reads or writes. Grouping uses the plan and summary Home already holds. No client call is added, so there's no new `.select(...)`. The existing ones keep naming their columns (criterion 26).
- No money arithmetic anywhere: `viewerBalance` reads roles, marks and `differenceOf` results as booleans. Amounts on rows still come from `rowAmount` / `formatCents` (unchanged).
- Hidden bills aren't deleted or marked on the server. They only aren't drawn.

## Dependencies on the Sent-via-Venmo session (splitit-app-92)
- **D-0 (done, 2026-11-26):** `HomeMarker` includes `sent` and `not_received` (type-only). `billMarker` doesn't return them yet, and `billMarkerView` returns `null` for both until 92 builds the pills (`sent` muted, only while someone owes the payer, so always in Owed to you; `not_received` accent, in Waiting on you). The group doesn't read markers, so Task 1 covers them through `MARKER_GROUPS` entries and fixtures that pin the plan each marker will come with (criterion 15). It doesn't wait for 92.
- **D-0b (92 says when it lands):** when 92 adds `seenAt: string | null` to `BillSummary`, the `summary()` builder in `lib/homeSections.test.ts` needs `seenAt: null` (and `__tests__/homeLayout.test.tsx`'s builders, if they build a `BillSummary` by hand). Whichever of 92's change and this slice's Task 1 / Task 2 lands second adds it. That's a one-line fixture edit, pre-approved for 92 in those two test files.
- **92's marker contract this slice relies on:** `sent` is returned only while at least one person owes the payer, and `settled` otherwise (rule 7). If 92 shipped `sent` on a zero balance, the row would still be Settled (the group reads the balance), but criterion 21's consistency check would flag it.
- **D-1 (needed for the "Claimed · waiting on others" pill; not blocking Task 1 or 2):** a new marker in `lib/homeMarkers.ts`, added by the homeMarkers owner (92, or whoever the main session assigns). Contract:
  - Kind `'waiting_on_others'`, in the `SettleMarker` union (it needs a plan).
  - In `billMarker`, only when the settle step returns `null`, **all** of these: a plan is given; `plan.status` is `blocked` or `blocked_all_zero`; `summary.payerId !== myId`; `summary.claimedAny`.
  - `billMarkerView`: pill **`Claimed · not ready to pay`** (user, 2026-11-26, A1.S7; it was "Claimed · waiting on others"), a11y `You've claimed. You can pay once the bill is ready`, tone `muted`, icon `null`.
  - How it differs: `unclaimed` ("Nothing claimed yet") means you've claimed nothing and items are left, so claiming is your move. `waiting_on_others` means you've claimed and the bill can't give amounts yet (an even-split bill still being claimed, or every item $0), so there's nothing for you to do. Both are muted, and both are in Waiting on you.
  - The same change adds `waiting_on_others: ['waiting']` to `MARKER_GROUPS` and a B-state fixture to `GROUP_FIXTURES` (D4; pre-approved). Without that line, typecheck fails, as intended.
  - Until D-1 lands, those rows sit in Waiting on you with no pill. That's the same group, just no words.
- **D-2 (optional follow-up, for 92 or the main session):** an early-plan `paid` marker with a difference shows "Paid $15.10" while the row is in Waiting on you (`more`) or Owed to you (`back`). The group is right (rule 6), but the pill doesn't say why. A later homeMarkers change could give early differences their own wording. Not part of this slice (Risk 3).
- **Tell 92 (main session relays):**
  1. Drop the planned `lib/homeSections.ts` / `WAITING_MARKERS` edits and fixtures. This slice covers `sent` and `not_received` (D4, criterion 15).
  2. SV-VIS-11's proposal P4 is decided by the user, and the answer is no: a fully paid bill goes to Settled at once, even with an unseen send (rule 7). The news is in Activity. `sent` shows only on Owed to you rows, while someone still owes.
  3. The UX doc §7.2 mock-ups and the line "For Sam, paying moves his row from Waiting on you to Recent (`Sent $15.10`)" are out of date. A guest who has sent their whole share is **hidden** (rule 4). Sam's "Sent $15.10" pill only shows if his bill comes back for another reason. There is no "Recent".
  4. `not_received` must leave the viewer unmarked with role `owes`, so the balance puts it in Waiting on you (`MARKER_GROUPS.not_received` is `['waiting']`; criterion 21 checks it).

## Tasks
Order: **1** (logic) → **2** (screen; `app/(app)/index.tsx` won't typecheck between 1 and 2, see below) → **3** (docs). D-1 runs in 92's session at any time; if it lands after Task 1, it adds its record line (D4).

| Task | Agent | Files (all in `splitit-app`) |
|---|---|---|
| 1 | implementer | `lib/homeSections.ts`, `lib/homeSections.test.ts` |
| 2 | product-engineer (loading `ui-ux-designer`) | `app/(app)/index.tsx`, new `components/ui/DisclosureRow.tsx` (A1.M1/S6; replaces the planned `components/SettledToggle.tsx`), `__tests__/uiPrimitives.test.tsx` (DisclosureRow tests), `__tests__/homeLayout.test.tsx`, `__tests__/homeMarkers.test.tsx` (section assertions, and the HM-5 test changed by A1.S5) |

**Sequencing (A1):** Task 1 starts only after splitit-app-92's Task 7 has finished its test edits in `lib/homeSections.test.ts` (the `fakeMark` helper, `seenAt` in the `summary()` builder, a `waiting_on_others` fixture). The main session confirms with 92 before starting Task 1. Task 1 then rebases its edits onto that file as 92 left it and keeps 92's fixtures, moving them into `GROUP_FIXTURES` where they fit.
| 3 | docs-writer | `docs/learning/concepts/design-system.md` (or `docs/learning/concepts/mobile-web.md`, wherever the Home sections note from the last slice landed), `docs/learning/concepts/in-app-notices.md`, `docs/before-production.md`, `docs/decisions-to-review.md` |

**Planned breakage (say "expected until Task 2" in the Task 1 report):** Task 1 removes `recent`, `WAITING_MARKERS`, `isWaiting` and `HomeRowView.waiting`. So `app/(app)/index.tsx` (lines 187–190, `homeSections(rows)`'s `recent`) and `__tests__/homeMarkers.test.tsx:294-295` fail typecheck until Task 2. Run Task 2 right after Task 1. Don't run the full suite or a whole-repo typecheck in between.

### Task 1: balance, group, record, sections (agent: implementer; about 250 lines with tests)
- `lib/homeSections.ts`: D1 (`viewerIsPayer`, `viewerBalance`), D2 (`homeGroup`), D4 (`MARKER_GROUPS`), D5 (`HomeGroup`, `HomeRowView.group`, `homeSections`, the copy). Remove `WAITING_MARKERS`, `isWaiting` and `recent`. Keep `rowAmount`, `rowTitle`, `peopleText`, `rowCaption`, `homeRowA11yLabel` and `HOME_COPY`'s bar strings unchanged. Imports `differenceOf` from `lib/settle.ts`. Don't edit `lib/homeMarkers.ts`, `lib/settle.ts` or `lib/settleView.ts`.
- `lib/homeSections.test.ts`: criteria 9–25. Replace the `WAITING_MARKERS` block and `ALL_MARKERS` with `GROUP_FIXTURES`. Build plans with the file's existing helpers (`planOf`, `exact`, `iPay`, `mark`, `facts`, `guestBill`, `myBill`), which go through `settlePlan` / `settleViewInputFor`, not by hand (lessons log 2026-11-25). Keep every existing criterion 7–11 and 17–18 test unchanged.
- Run `npx jest lib/homeSections.test.ts` and `npx tsc --noEmit -p . 2>&1 | grep -v "app/(app)/index.tsx\|__tests__/homeMarkers.test.tsx"` (or report the typecheck output and name the expected files).

### Task 2: three groups, Settled toggle, all-caught-up (agent: product-engineer, loading `ui-ux-designer`; about 250 lines with tests)
- `app/(app)/index.tsx`: D6. `sections` from `homeSections(rows)`. Add `settledOpen` state per D7, reset when `settled.length === 0`. All copy from `lib/homeSections.ts`.
- New `components/SettledToggle.tsx`: D7.
- `__tests__/homeLayout.test.tsx`: criteria 27–38. Update the "Recent" tests (lines 481–547 today) to the new groups. Keep what each checks: order inside a group, a group missing when empty, moves when settle data lands, and `keepCandidates` on refresh. Each changed assertion is listed in the report.
- `__tests__/homeMarkers.test.tsx:294-295`: `[...waiting, ...recent]` becomes the rendered order `[...waiting, ...owed]` (plus settled only if the test opens the toggle). Don't change any other assertion. Settle-pill tests (SE-UX-14, R4, failure drops pills) and test 36 (Home never navigates by itself) pass with only the row-placement edits listed.
- Accessibility: compare every heading's role and every row's role, label and hint before and after (lessons log 2026-11-25, "Restyles dropped heading roles").
- Absence checks (e.g. "Owed to you" not shown, a hidden row not shown) first wait for a positive marker that the data they depend on has landed, such as a value only the new plan produces (lessons log 2026-11-26, twice).

### Task 3: docs (agent: docs-writer; after Tasks 1–2 land; hand it this spec, the review findings and the QA report in full)
- The concept note that holds "Home on a phone" (`docs/learning/concepts/design-system.md` or `mobile-web.md`): replace the two-sections paragraph with the three groups and hidden. Cover: why groups come from the viewer's balance (rules 6 and 7: markers decide only the pill, and the user reversed an earlier marker-first idea), why nothing is hidden on a guess (GV-5), and the single `viewerIsPayer` helper for future multi-payer bills. Add one check-yourself question.
- `docs/learning/concepts/in-app-notices.md`: one paragraph on how 92's `sent` interacts with Settled.
- `docs/before-production.md`: the items in "Before-production items" below.
- `docs/decisions-to-review.md`: update any GV row the build changed. Mark HR-8, HR-10 and HR-11 "superseded by GV-…" where they no longer hold.

## Acceptance criteria

### Pure logic: Task 1 (`lib/homeSections.test.ts`)
Fixtures: viewer `ME`; host `HOST` (Hana); `DEE`; plans through the existing helpers.

9. `viewerIsPayer` uses the plan's `payerId` when the plan is `ready` or `early`, and `summary.payerId` otherwise (no plan, `blocked`). A fixture where the summary says ME pays but the ready plan says HOST pays → `false`. `grep -nE "payerId\s*[!=]==|===\s*\w*\.?payerId" lib/homeSections.ts` matches only lines inside `viewerIsPayer` (Grep tool, 2026-11-26, same pattern on `lib/homeSections.ts`: no matches today).
10. `viewerBalance` is `{ known: false }` for: no plan; `blocked`; `blocked_all_zero`; `blocked_bad_payer`; a ready plan with no entry for ME.
11. **Guest balance boundaries** (ready plan, HOST pays, `SETTLE_DIFF_IGNORE_CENTS` = 1):

| # | ME's share | ME's mark | `owes` | `owed` | group |
|---|---|---|---|---|---|
| G1 | 1480 | none | true | false | waiting |
| G2 | 1480 | 1480 | false | false | hidden |
| G3 | 1481 | 1480 (1¢ over, within tolerance) | false | false | hidden |
| G4 | 1482 | 1480 (2¢ over) | true | false | waiting |
| G5 | 1479 | 1480 (1¢ under) | false | false | hidden |
| G6 | 1478 | 1480 (2¢ under) | false | true | owed |
| G7 | 0 (`nothing`) | none | false | false | hidden |
| G8 | −100 (`payer_owes_them`) | none | false | false | hidden (GV-4) |
| G9 | −100 | 500 | false | true (`back` 500) | owed |

12. **Payer balance boundaries** (ready plan, ME pays; HOST and DEE owe 500 and 300):

| # | HOST | DEE | `owes` | `owed` | group |
|---|---|---|---|---|---|
| P1 | unmarked | unmarked | false | true | owed (`left_to_pay`) |
| P2 | marked 500 | marked 300 | false | false | settled (`settled`) |
| P3 | marked 500 | marked 301 (1¢, within) | false | false | settled |
| P4 | marked 500 | marked 298 (`more` 2) | false | true | owed (`differences`) |
| P5 | marked 500 | marked 302 (`back` 2) | true | false | waiting (`differences`) |
| P6 | marked 498 (`more` 2) | marked 302 (`back` 2) | true | true | owed (step 4 before 5, GV-2) |
| P7 | unmarked | marked 302 (`back` 2) | true | true | owed (`left_to_pay`) |
| P8 | `nothing` (0), unmarked | `nothing`, unmarked | false | false | settled (no marker, GV-7) |
| P9 | `payer_owes_them` (−100), unmarked | marked 300 | false | false | settled (GV-4) |

13. **Every reachable cell of D3** has one test, named by its cell (e.g. `"D3 guest E paid back → owed"`). They include: payer N (incomplete, no plan) → owed; payer L (complete, settle map has no entry) → owed; payer B (`blocked_all_zero`) → owed; payer E (no marker) → owed; guest L (claimed, complete, no facts) → waiting with `pill` null; guest B (even mode, claimed, incomplete) → waiting; guest E `owes` → waiting; guest E `paid` with a zero, `more` and `back` difference → hidden, waiting, owed; guest E `nothing` → hidden; guest R with ME missing from the plan → waiting.
14. `new` → waiting for a guest (no facts), and owed for a payer who isn't the host (no facts; GV-10). `unclaimed` → waiting.
15. **92's kinds, before their pills exist:** `GROUP_FIXTURES.sent` holds a payer plan with one person unmarked and one marked (the state 92 will mark `sent`) → `homeGroup` gives `owed`. The **same plan with the last person marked** (zero, where 92 returns `settled`) → `settled` (rule 7: never held in Owed by an unseen send). `GROUP_FIXTURES.not_received` holds a G1 plan (unmarked, owes) → `waiting`. These call `homeGroup` directly, since `billMarker` can't return those kinds yet. A note in the test says the pills are null until 92 ships.
16. **Loading never hides or settles:** for every guest fixture whose ready group is `hidden` (G2, G3, G5, G7, G8), the same summary with `facts` undefined → `waiting`. For every payer fixture whose ready group is `settled` (P2, P3, P8, P9), with `facts` undefined → `owed`.
17. **Coming back (rule 6):** each row of D3's "Coming back" table is a test that builds the start plan and the after plan with the same helpers, and checks both groups. This includes the two "back to zero" rows (guest `paid_more` → pays the difference → hidden; payer `differences` → paid → settled), the "joined and claimed nothing" row (stays settled), and "the last person pays → Settled at once".
18. **The group is the balance:** over every fixture in criteria 11–17, `settled` or `hidden` ⇔ the balance is known with `owes === false && owed === false` (plus `final` for `settled`; a zero early payer plan is `owed`). A known non-zero balance → `owed` when `owed`, else `waiting`. `homeGroup`'s parameter type has no `marker` field (a `// @ts-expect-error` line passing one proves it).
19. **Coverage that fails when the union grows:** `MARKER_GROUPS` is declared as `Readonly<Record<HomeMarker, readonly HomeGroup[]>>` (no `Partial`, no index signature, no cast). The test declares `GROUP_FIXTURES: Record<HomeMarker, readonly GroupFixture[]>`, and asserts that every key of `MARKER_GROUPS` has at least one fixture and that the two key sets are equal. The Task 1 report shows it fails: temporarily delete one key from `MARKER_GROUPS` and paste the `tsc` error (`Property '…' is missing`), then restore it.
20. `MARKER_GROUPS` equals D4 exactly (`toEqual` on the whole object).
21. **Pill and group can't disagree:** over every fixture built through `homeRowView`, `row.marker === billMarker(summary, ME, plan)`; `row.pill` deep-equals `billMarkerView(row.marker, …)` (or is null when the marker is null); `row.group === homeGroup({ summary, plan, myId: ME })`; and when `row.marker !== null`, `MARKER_GROUPS[row.marker]` includes `row.group`. For the `sent` / `not_received` fixtures (criterion 15), the expected group is in their `MARKER_GROUPS` entry.
21a. **(A1.M2) To collect.** `rowAmount` gives `{ kind: 'collect', cents }` exactly when `viewerIsPayer`, the plan is `ready`, and the group is `owed`. The cents are A1.M2's sum. Expected (fixtures of criterion 12): P1 → 800; P4 → 2; P6 → 2 (the `more` counts, the `back` doesn't); P7 → 500; the criterion 15 `sent` fixture → the unmarked person's share only. P2, P3, P8 and P9 (Settled) → `total`; P5 (Waiting, pay-backs only) → `total` (C6 skipped); a payer with an early, blocked or no plan → `total`. A guest's amount is unchanged on every guest fixture (`paid_back_due` stays `share`, C2 skipped). Boundary: a `more` difference of exactly 1¢ is within tolerance and adds 0 (P3's shape mirrored); 2¢ adds 2. `amountLabel('collect')` → `To collect`. The row label for P1 is `Your bill, Nov 20, 3 people, to collect $8.00. 2 people still have to pay you` (people count as in the fixture). Every figure is `formatCents`.
21b. **(A1.M2) The sum is in one place.** `grep -nE "owedCents|\.cents\b" lib/homeSections.ts` matches only lines inside the collect function and the existing `rowAmount` share line. The implementer runs it first and pastes today's matches into the report; it was not run at spec time.
22. `homeSections` is a stable partition: input `[w1, o1, s1, h1, w2, o2, s2, h2]` → `waiting [w1, w2]`, `owed [o1, o2]`, `settled [s1, s2]`, `hiddenCount 2`. `[]` → all empty, `hiddenCount 0`. All hidden → three empty arrays, count = length.
23. Copy: `HOME_SECTION_TITLES` equals D5. `settledToggleText(5)` → `Settled (5)`. `settledToggleA11y(1)` → `Settled, 1 bill`, and `(2)` → `Settled, 2 bills`. The two hints, `allClear` and `hiddenNote` match D5. (A1) `HOME_COPY.settledShow` → `Show`, `HOME_COPY.settledHide` → `Hide`, `amountLabel('collect')` → `To collect`.
24. `grep -rnE "'Recent'|\"Recent\"" app components lib` prints nothing (Grep tool, 2026-11-26, same pattern over `app`, `components`, `lib`: matches `lib/homeSections.ts:22` today). `grep -rn "'Owed to you'" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/homeSections.ts` (no matches today). `grep -rn "all caught up" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/homeSections.ts` (no matches today).
25. `npx jest lib/homeSections.test.ts` passes. The criterion 7–11 and 17–18 tests from the last slice are unchanged.

### Screen: Task 2 (`__tests__/homeLayout.test.tsx`, updated tests; router tests on web **and** iOS `Platform.OS`)
26. No new client read: `__queries` for a Home load are the same tables and `select` columns as before this slice (`my_bills` rpc, `fetchSettleData`'s four reads, `fetchPeopleCounts`). `grep -rnE "\.select\(\)|select\('\*'\)" lib app components` prints nothing (Grep tool, 2026-11-26: no matches today).
27. With bills `[guest owes (X), payer left_to_pay (Y), guest paid (W), payer settled (S1), payer settled (S2)]`: Home shows the header "Waiting on you" with X, then the header "Owed to you" with Y, then a button "Settled, 2 bills" (visible `Settled (2)`), collapsed, with S1 and S2 not rendered. W isn't rendered anywhere. Assert W's absence only after X's "You owe" pill is found (the plan has landed). (A1.M2) Y's figure is its amount still to collect, labelled `To collect`, not the bill total.
28. Pressing the toggle shows S1 then S2 (list order) in a card under it. The toggle's `accessibilityState.expanded` goes `false` → `true`, and the hint changes from `Shows bills everyone has paid you for` to `Hides settled bills`. Pressing again hides them. Each row under Settled is a `link` with hint `Opens this bill` and pushes `/bills/<id>`. (A1.S3) Settled rows render **no pill text** (no visible `Settled up`), but each row's `accessibilityLabel` still ends with `. Settled up, everyone has paid you`. Positive control: before asserting the pill's absence, find the S1 row by its label.
29. (A1.M1/S1/S6) The toggle is `DisclosureRow`. Its `Pressable`'s flattened style has `minHeight` ≥ 44, and it spans the column width. It renders **no `ChevronRight`**: closed shows the word `Show` and a `ChevronDown`, open shows `Hide` and a `ChevronUp`. Tested by finding the icon components in the tree, with a positive control that finds the icon that should be there. The word and the chevron aren't announced: they sit in a `View` with `accessible={false}` and `importantForAccessibility="no-hide-descendants"`, and the button's label stays `Settled, n bills`. The word uses `colors.primary` at weight `'600'`. The label `Settled (n)` uses `type.section` / `textMuted`. The toggle has `marginVertical: -(TOUCH_TARGET - type.section.lineHeight) / 2`, computed from the tokens (−13 today), not a literal. `__tests__/uiPrimitives.test.tsx` also covers `DisclosureRow` on its own: props in, role, state, hints, words, icons.
29a. (A1.S2) Opening Settled when the first settled row would sit below the visible scroll area calls the `ScrollView`'s `scrollTo` once, with `{ y: toggleY + TOUCH_TARGET + space.sm + ROW_MIN_HEIGHT + space.lg - visibleHeight, animated: !reduceMotion }`, from mocked layout values. Opening when the row is already visible doesn't scroll. Closing never scrolls. With Reduce Motion on, `animated` is `false`. Verify how Reduce Motion is read on web in the installed react-native-web (`AccessibilityInfo.isReduceMotionEnabled`) and reword if it differs.
30. The open state survives a focus refresh (open, blur, focus, the list reloads: still open) and resets after Home remounts (unmount, render again: collapsed). When a refresh leaves 0 settled bills the toggle is gone, and when a later refresh brings one back it's collapsed.
31. **All caught up:** bills that are all hidden → the card `You're all caught up.` with `Bills you've paid don't show here.`, no section headers, no toggle, the bar present. All settled → the card without the hidden note (hiddenCount 0), plus `Settled (n)`. Mixed hidden and settled → the card with the note, plus the toggle. Wait first for a plan-only marker (e.g. the toggle's count) before asserting what's absent. (A1.S4) The card's inner `View` is one accessible element: its label is `You're all caught up. Bills you've paid don't show here.` (or `You're all caught up.` alone when `hiddenCount` is 0), with no role. `allClear` uses `colors.text`, `hiddenNote` uses `colors.textMuted`, and the card's gap is `space.xs`.
32. Loading, error and 0 bills still show "Your bills" and today's text, with no group header, no toggle and no all-caught-up card.
33. **(A1.M3, A1.S5) The first load waits up to 1000 ms; refreshes never reshuffle.** Each case below has its own test (lessons log 2026-11-26). Guard tests are shown once to fail with the guard removed.
  - (a) First load, list landed, first settle read held open: the "Your bills" spinner card shows, and no group header, row or toggle does.
  - (b) Resolve the read before 1000 ms: the final groups appear in one render. W is absent (wait first for S's toggle), and S is under a collapsed `Settled (1)`. W never appeared in any earlier render: a render spy or `toJSON` snapshots taken while pending contain no W label.
  - (c) With fake timers, the read still held open at `FIRST_SETTLE_WAIT_MS` (1000): GV-5's fallback renders. W is under "Waiting on you" with no pill, and S is under "Owed to you". Then resolve the read: W goes, S moves to Settled.
  - (d) First read fails before 1000 ms: the fallback renders at once (no wait for the timer).
  - (e) A list with no settle candidates (`fetchSettleData([])`) renders without waiting.
  - (f) Refresh (focus) with the settle read held open: no spinner, W stays hidden, S stays settled (`keepCandidates`).
  - (g) Refresh whose settle read **fails**: W stays hidden and S stays settled, with every pill on the screen unchanged and no error (the previous facts are kept, A1.S5). Positive control: the failed read was made (`__queries`).
  - (h) Unmount during the 1000 ms wait: no state update after unmount, and the timer is cleared (held-open read, then unmount, then resolve, then check no render error).
34. **Coming back on screen:** a refresh whose new plan gives W a `paid_more` difference moves W to "Waiting on you" with the `Paid · $X more to pay` pill. A refresh whose plan gives S a `more` difference moves S out of Settled into "Owed to you" with the `differences` pill (the toggle disappears if S was the only one).
35. One filled button on Home in every state above (exactly one `Button` with `variant="primary"`: "Scan receipt"). The toggle and the card have no fill. "Split a bill" is still a header (`homeMarkers.test.tsx` "visual-pass R2" passes unchanged).
36. Headings: `getByRole('header', { name: 'Waiting on you' })` and `getByRole('header', { name: 'Owed to you' })` when they have rows. `queryByRole('header', { name: /Recent/ })` is null after the rows have rendered.
37. Home never navigates by itself: `__tests__/homeMarkers.test.tsx` test 36 passes unchanged on iOS and web. The SE-UX-14 / R4 / failure tests at the end of that file pass with only the row-placement edits listed in the report.
38. `app/(app)/index.tsx` does no money arithmetic and no grouping of its own: it doesn't read `plan.people`, `mark`, `owedCents` or `differenceOf`, and every group comes from `homeSections` (reviewer check; also `grep -nE "owedCents|differenceOf|\.people\b|\.mark\b" "app/(app)/index.tsx"` prints nothing. Grep tool, 2026-11-26: no matches today).

### Whole slice
39. `npm run typecheck` and `npm test -- --maxWorkers=2` pass (not while another session runs a full suite). A failure only in files this slice didn't touch is reported as outside the task.
40. No file outside the Task table changed (`git status` compared with the start). In particular `lib/homeMarkers.ts`, `app/_layout.tsx`, `app.json`, `vercel.json`, `supabase/` and `components/AppBanner.tsx` are untouched by this slice.
41. Docs (Task 3): each bullet is done or reported skipped with a reason. GV rows match the build.

### User checks (need a person; QA lists them "for the user")
- **U1. Groups on web, two Google accounts (local stack, Chrome about 390 px wide).**
  1. As A: create bill X (two items, $10 and $20) and share it. As B: join X and claim the $10 item. As A: claim the $20 item. A is the payer.
  2. As B on Home: X is under "Waiting on you" with "You owe $…". (It may first appear with no pill for a moment; record whether that's noticeable.)
  3. As B: Settle up → mark paid. Back on Home: X is **gone**. If B has no other open bills, the "You're all caught up." card shows with "Bills you've paid don't show here."
  4. As A on Home: X is in a collapsed "Settled (1)" with a teal "Show" and a down chevron. Tap it: the word becomes "Hide", and X shows **without a pill**. If it would open behind the bottom bar (narrow the window's height to check), the list scrolls just enough to show X. Tap again: hidden. Open X and come back: still as you left it. Reload the page: collapsed, and the bills appear only once (a short spinner, no rows jumping between groups).
  5. As A: edit X and raise the $10 item to $12 (save). As B on Home: X is back under "Waiting on you" with "Paid · $… more to pay". As A on Home: X is under "Owed to you" with the amount still to collect (the difference) and the label "To collect", not the bill total. Settled is gone.
  6. As B: pay the difference. Both Homes: X is hidden for B and Settled for A again.
  7. Record whether the three groups read calmly; whether "Settled (1) · Show" reads as something you can tap; whether the instant open feels abrupt (if so, C1's fade is the later idea); whether "You owe $X" next to "$X Your share" reads as noise (HR-4 kept); and how long the first-load spinner felt.
- **U2. Screen reader** (VoiceOver on the iOS simulator or a browser screen reader): heading navigation lands on "Waiting on you", "Owed to you" and "Split a bill". The toggle reads "Settled, 1 bill, button, collapsed" with its hint, and "expanded" after a tap.

Device note: U1 and U2 use the Mac's `http://127.0.0.1:54321` (web on the Mac, or the iOS simulator). A physical phone isn't needed. If wanted, it's blocked as in the last spec (no LAN setup or hosted backend for this slice).

## Before-production items (Task 3 adds them to `docs/before-production.md`)
- §8: hidden bills still count toward `my_bills()`'s 20-bill limit. A person with many paid-up bills can lose older open ones off Home (Q2).
- §8 (amended by A1): Home's first load waits up to `FIRST_SETTLE_WAIT_MS` (1000 ms, starting value) for the settle read. After a timeout or a failed **first** read, paid-up guest bills show in Waiting on you with no pill, and settled bills show in Owed to you, until a read lands. A failed **refresh** keeps the previous plans, so its pills can be one refresh stale (A1.S5 changes HM-5 on Home). Revisit both after the friend test.
- §8: a hidden bill has no way back from Home (Q1).
- §4: multi-payer bills (backlog item 4) change `viewerIsPayer` and the payer branch of `viewerBalance` (Risk 5).

## Risks
1. **First-load moves (reduced by A1.M3).** The list waits up to 1000 ms for the first settle read, so rows normally appear once, in their final groups. On a slow connection (over 1000 ms), the GV-5 fallback still shows paid-up bills that then move. The cost is a first paint up to 1 s later than the list alone (the user accepted it, 2026-11-26).
2. **Stale pills after a failed refresh (A1.S5).** Home keeps the previous plans when a refresh's settle read fails, so a pill can be one refresh out of date with no error shown. HM-5's "drop on failure" now applies only to the first read. The bill and Settle screens still show current data.
3. **Early-plan pill mismatch** (D-2): "Paid $15.10" under Waiting on you or Owed to you when an early share moved. The Settle screen explains it. A homeMarkers wording change is the fix.
4. **Pay-back hidden behind collecting** (GV-2): a payer who owes a pay-back and is also owed sits in Owed to you, under a "left to pay" or "differences" pill. The Settle screen shows both.
5. **Multi-payer later** (backlog item 4): groups are defined by `owes` / `owed` / zero, so the groups survive, but "the payer" becomes "a payer" and the payer row of D1's table needs a per-payer rule. The rule is kept in one helper (`viewerIsPayer`) and one table branch so that change has one place to go. Nothing is built for it now.
6. **Coordination:** groups don't read markers, so 92's marker priority can't move a row. If 92's pills land in a combination D4 doesn't allow (e.g. `sent` on a zero balance), criterion 21 fails and the mismatch goes to 92.
7. **Groups MVP (splitit-app-52) later:** its block goes in the reserved slot between Owed to you and Settled, and its filter is one line before `homeRowView` (D6). "You're all caught up." may need a group-aware condition then; that's 52's call.

## Questions for the user
Neither blocks a task.

- **Q1. Getting back to a hidden bill.** Once you've paid, the bill leaves Home. Today the only ways back are the original link, or the bill reappearing when its money changes. Options: (a) nothing for now. The friend test shows whether anyone misses it. Recommended: it's your rule as given, and costs nothing. (b) A second collapsed row, "Paid (3)", under Settled for your guest bills. It's one more toggle, and it reuses this slice's component. (c) A "Your history" screen later (PRODUCT.md lists "bill history beyond Home" as not built). Which do you want?
- **Q2. The 20-bill limit.** Home lists your 20 newest bills, and hidden ones still count. Someone with many paid-up bills could lose an older open bill off Home. Fixing it means changing `my_bills()` (a migration, and `supabase/` is the deploy session's), for example to list open bills first. Do you want that after the deploy settles? (Recommended: yes, but only if the friend test shows people with more than about 15 bills.)

Decisions made on your behalf (GV-1 to GV-20) are in `docs/decisions-to-review.md` under "2026-11-26 · Home groups v2". The ones most worth a look:
- GV-5: nothing is hidden or settled until the plan confirms it (now with a first-load wait, A1.M3).
- GV-2: owed beats owes for a payer.
- GV-3: a guest owed a pay-back goes to Owed to you.
- GV-4: negative shares settled outside the app don't count.
- GV-11: Settled isn't remembered across launches.

---

## A1 · UX review, 2026-11-26
Source: `docs/specs/2026-11-26-home-groups-v2-ux-review.md`. The user decided M2, M3, S5 and S7 in chat on 2026-11-26. The main session accepted M1, S1–S4, S6, S8 and C3, and skipped C1, C2, C4, C5 and C6 (listed under "Later ideas"). **Where this amendment and the body above differ, this amendment wins.** The criteria it touches (13/21 → 21a/21b, 23, 27, 28, 29 → 29/29a, 31, 33, U1 steps 4, 5 and 7) are already rewritten above. New decisions are GV-21 to GV-28 in `docs/decisions-to-review.md`.

### A1.M1 + S6. The Settled toggle is a shared `DisclosureRow` (replaces D7's "Look" bullet and `components/SettledToggle.tsx`)
- New primitive `components/ui/DisclosureRow.tsx`. Props: `{ label: string; a11yLabel: string; open: boolean; onToggle: () => void; showHint: string; hideHint: string; showText: string; hideText: string }`. Home uses it directly, with no `SettledToggle` wrapper (GV-21):
  - `label={settledToggleText(n)}`, `a11yLabel={settledToggleA11y(n)}`;
  - `showText={HOME_COPY.settledShow}` (`'Show'`), `hideText={HOME_COPY.settledHide}` (`'Hide'`);
  - the two D5 hints.
- Layout:
  - One `Pressable`, full column width, `flexDirection: 'row'`, `alignItems: 'center'`, `gap: space.sm`, `minHeight: TOUCH_TARGET`, `paddingHorizontal: space.xs`.
  - Left: `label` in `type.section`, `colors.textMuted`, `flex: 1, minWidth: 0` (wraps at large text).
  - Right, in a `View` with `accessible={false}` and `importantForAccessibility="no-hide-descendants"`, `flexDirection: 'row'`, `gap: space.xs`: `showText` / `hideText` in `type.caption` at `fontWeight: '600'`, `colors.primary`; then `Icon` `ChevronDown` (closed) or `ChevronUp` (open), `size="sm"`, `colors.primary`.
  - **Never `ChevronRight`**: on Home that means "opens a screen".
  - This is the same disclosure language as `components/SharesSummary.tsx`.
- Pressed: `opacity.pressed`. Focus: `useFocusRing` with `radius.sm`, `borderCurve: 'continuous'`.
- Unchanged from D7: role `button`, `accessibilityState={{ expanded: open }}`, the hints, the open state rules (GV-11).
- **For splitit-app-52:** use `DisclosureRow` for "Hidden groups (N)", with the same Show/Hide words (the main session relays this).

### A1.M2. "To collect $X" on the payer's Owed-to-you rows (amends home-mobile-refresh D3, and D5 and D9 here)
**Shared contract, defined once in `lib/homeSections.ts`:**
- `RowAmountKind` gains `'collect'`.
- `amountLabel('collect')` is `'To collect'`.
- `homeRowA11yLabel`'s amount phrase for it is `` `to collect ${formatCents(cents)}` ``.

**When it applies.** `rowAmount` becomes `rowAmount(summary, myId, plan, group)`. It returns `collect` when **all** of these hold: `viewerIsPayer(summary, plan, myId)`, `plan.status === 'ready'`, and `group === 'owed'`. Otherwise it returns today's result: the host's total, the guest's share, or the total.

**Formula** (`collectCents(plan, myId)`, exported, the only money sum in the file):

`Σ over every entry o with o.userId !== myId and o.role !== 'payer'` of
`(o.mark === null && o.role === 'owes' ? o.owedCents : 0) + (differenceOf(o)?.kind === 'more' ? differenceOf(o).cents : 0)`.

- It's integer cents, with no rounding.
- The tolerance is `differenceOf`'s (`SETTLE_DIFF_IGNORE_CENTS`, 1¢), so a 1¢ difference adds 0. This is the same rule as `viewerBalance`'s `owed`, so `collectCents > 0` ⇔ `owed`. Criterion 21a tests both sides on the same fixtures.
- `back` differences (the payer owes) aren't subtracted. The figure is what's coming in, not a net amount (GV-22).

**Where it doesn't apply.**
- Early, blocked and no-plan payer rows keep `Total`, because shares can still move (HR-3's reasoning).
- Settled rows keep `Total`.
- A payer in Waiting on you (pay-backs only) keeps `Total` (C6 skipped).
- Guests are unchanged (C2 skipped).

**D9 amended.** "No money arithmetic outside `lib/homeSections.ts`'s `collectCents`: one sum, tested." Components still do none, and criterion 38's grep still holds.

**Example.** `Your bill · Nov 22 · 4 people · $31.20 To collect · (2 people left to pay)`.

### A1.M3. The first load waits up to 1000 ms for settle data (user decision; reverses SE-UX-14 / HR-11 for the first load only)
- `FIRST_SETTLE_WAIT_MS = 1000` (starting value, exported from `lib/homeSections.ts` so tests and the screen share it).
- In `HomeScreen`: a `firstSettleDone` ref plus state, `false` on mount.
  - On the **first** successful `listMyBills` of this mount, start a timer for `FIRST_SETTLE_WAIT_MS`.
  - `firstSettleDone` becomes `true` when the first `fetchSettleData` resolves (ok or not) or the timer fires, whichever comes first. The timer is cleared then, and on unmount.
  - With no candidates, the read resolves at once, so there's no visible wait.
- While `bills.status === 'ready'` and `!firstSettleDone`, the bills area renders the **existing loading state** ("Your bills" + spinner card), exactly as during `loading`. The notice card, the Venmo prompt and the bar render as usual. Counts (`fetchPeopleCounts`) don't hold the list.
- After the timeout, the GV-5 fallback (no plan → guest Waiting, payer Owed) renders. When the read lands later, rows move once.
- **Refreshes never wait** (focus, foreground, after dismiss). `keepCandidates` keeps the previous facts, as before.
- An error on the first list read shows the error card as today (no wait).

### A1.S1. The toggle stays on the heading grid
- The `DisclosureRow` gets `marginVertical: -(TOUCH_TARGET - type.section.lineHeight) / 2`, computed from the tokens (−13 today). The label then sits 24 pt below the previous card, like every heading, and the 44 pt target is kept.
- The toggle and the open card sit in one `View` with `gap: space.sm`, keyed `settled`.

### A1.S2. Opening scrolls the first settled row into view
- Home holds a `scrollRef` on the `ScrollView`, records `toggleY` from the settled `View`'s `onLayout`, and tracks `scrollY` (`onScroll`, `scrollEventThrottle={16}`) and the visible height (`onLayout` of the `ScrollView`).
- On **open only**: if `toggleY + TOUCH_TARGET + space.sm + ROW_MIN_HEIGHT > scrollY + visibleHeight`, call `scrollRef.current?.scrollTo({ y: toggleY + TOUCH_TARGET + space.sm + ROW_MIN_HEIGHT + space.lg - visibleHeight, animated: !reduceMotion })`. Closing never scrolls.
- `reduceMotion` comes from `AccessibilityInfo.isReduceMotionEnabled()`, read once on mount and kept up to date through `AccessibilityInfo.addEventListener('reduceMotionChanged', …)`. Verify both on the installed react-native-web; if web lacks them, `animated: false` on web.

### A1.S3. No visible "Settled up" pill inside Settled
- `BillRow` takes `showPill: boolean`. Home passes `row.group !== 'settled'`.
- `row.pill` and `row.a11yLabel` are unchanged: the label keeps `. Settled up, everyone has paid you`, because the toggle is a button, not a heading, so a screen-reader user gets no "Settled" context otherwise.

### A1.S4. The all-caught-up card
- `Card` (default, not muted), with its gap overridden to `space.xs`.
- `allClear` in `type.body`, **`colors.text`**. `hiddenNote` in `type.caption`, `colors.textMuted`.
- The inner `View` is `accessible`, with `accessibilityLabel` = `hiddenCount > 0 ? `${allClear} ${hiddenNote}` : allClear`. No role, no heading.

### A1.S5. A failed refresh keeps the previous plans (user decision; changes HM-5 on Home)
- In `loadBills`, a failed `fetchSettleData` sets `setSettle((prev) => keepCandidates(prev, candidates))` instead of `NO_SETTLE`, **except on this mount's first settle read**, where it stays `NO_SETTLE` (A1.M3's fallback). Pills, groups and amounts then stay as they were. There's still no error banner.
- Planned breakage: `__tests__/homeMarkers.test.tsx` "44 / HM-5: a failed settle read on refresh drops every settle pill, with no error banner" (line 904 today) asserts the old drop. Task 2 rewrites it to the new rule: pills kept on a refresh failure, dropped on a first-load failure. Keep the "no error banner" assertion. List the change in the report. The coordinator has asked 92 whether its tests assert the old drop; any 92 test that does is updated in 92's session.
- GV-5 is amended (GV-24).

### A1.S7. Pill copy
`waiting_on_others`'s pill is **`Claimed · not ready to pay`** (user). 92 builds it (D-1 updated above).

### A1.S8. No motion
- D6 gains: "Rows change group without motion. No `LayoutAnimation`, Reanimated layout transition or fade when a row moves, appears or goes."
- D7 gains: "The Settled card appears and disappears with no animation. The toggle's feedback is pressed opacity and the Show/Hide word." The only animated thing is S2's `scrollTo`, and it's off under Reduce Motion.

### A1.C3. HR-4 kept
"You owe $X" next to "$X Your share" stays for this slice. U1 step 7 records whether it reads as noise.

### Later ideas (skipped in this slice)
- **C1:** a 150 ms fade-in for the opened Settled card, only if U1 finds the instant open abrupt.
- **C2:** a guest's `paid_back_due` row shows the pay-back as the figure (`Back to you`).
- **C4 (for splitit-app-52):** scope the caught-up card to bills once group rows sit on Home ("You're all caught up on bills.").
- **C5:** a shorter sticky bar (the heading for screen readers only), which needs HR-1 and review R2 revisited.
- **C6:** `To pay back $X` for a payer who only owes pay-backs.

### Task changes from A1
- **Task 1** (after 92's Task 7 test edits, see "Sequencing"):
  - adds `collectCents`, `RowAmountKind 'collect'`, `rowAmount`'s `group` parameter (`homeRowView` computes the group first, then the amount), `FIRST_SETTLE_WAIT_MS`, `HOME_COPY.settledShow` and `settledHide`;
  - criteria 21a, 21b and 23's additions;
  - about 300 lines with tests. If it goes over, split M2 into a Task 1b in the same files.
- **Task 2:**
  - builds `components/ui/DisclosureRow.tsx` (with tests in `__tests__/uiPrimitives.test.tsx`), A1.M3's wait, A1.S1–S5 and S8 in `app/(app)/index.tsx`;
  - criteria 27, 28, 29, 29a, 31 and 33 as rewritten;
  - about 350 lines. If it goes over, split it into Task 2a (DisclosureRow + groups + caught-up card + S3) and Task 2b (M3 wait + S5 + S2 scroll), run one after the other on the same files.
- **Task 3:** the concept note also covers the first-load wait, "kept on failed refresh", and "To collect". `docs/before-production.md` item 2 as amended above.

---

## Built (note, 2026-11-27)
Tasks 1 and 2 are built. Review round 1 was approved with R1–R6 and R8 fixed, and QA passed. Task 3 (docs) is done (criterion 41). The body and A1 above are left as written. The build differs from them in these places:

- **R2: one D3 cell changed (user rule 1).** "Guest: E, none, `nothing` → hidden" is now **Waiting on you** when the viewer has claimed nothing and the plan isn't final. `homeGroup` step 7 reads `!b.final && !summary.claimedAny ? 'waiting' : 'hidden'`, so `homeGroup`'s input type is `Pick<BillSummary, 'payerId' | 'claimedAny'>`, not just `payerId` as D2 shows. In practice this is a host who isn't the payer and hasn't claimed yet. GV-8 carries a note.
- **R6: criterion 29a's formula.** The Settled block's top (`toggleY`) is the toggle's label line, not its 44-pt target, because of `DISCLOSURE_ROW_MARGIN` on both sides. Built as `y = toggleY + TOUCH_TARGET + 2 × DISCLOSURE_ROW_MARGIN + space.sm + ROW_MIN_HEIGHT + space.lg − visibleHeight`, using the same sum without `space.lg` for the "already visible" check (`settledScrollTarget` in `app/(app)/index.tsx`). R4 also moved the scroll to the opened card's `onLayout`, because a browser clamps `scrollTo` before the card has laid out.
- **Rename.** A1.M2's `collectCents(plan, myId)` is `stillToCollectCents`. `lib/settle.ts`'s ready plan already has a `collectCents` field with a different meaning (every positive share, paid or not). Criterion 21b's grep pattern still applies to the renamed function.
- **`rowAmount`'s `group` is optional.** The signature is `rowAmount(summary, myId, plan, group?: HomeGroup)`. Without a group (callers from before groups v2), the amount is never `collect`. `homeRowView` always passes it.
- Also from review, with no criterion change: R1 (`DisclosureRow` passes `aria-expanded` and `aria-hidden` for web, because react-native-web 0.21 drops `accessibilityState`) and R3 (`keepCandidates` drops a kept plan whose payer differs from the new list's).
- **D7's `components/SettledToggle.tsx` was not created.** A1.M1 replaced it with `components/ui/DisclosureRow.tsx`.

Docs written: `docs/learning/concepts/design-system.md` section 10 (rewritten) and the primitives table, `docs/learning/concepts/in-app-notices.md`, `docs/learning/README.md`, `docs/before-production.md` (§4, §6, §7, §8) and `docs/decisions-to-review.md` (HR-8, HR-10 and HR-11 marked superseded, notes on GV-5, GV-8, GV-12 and GV-15, and a build-notes block after GV-28).
