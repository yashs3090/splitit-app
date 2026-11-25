# Venmo Request buttons for the payer

Date: 2026-11-25. Repo: `splitit-app` only (ADR 0011). No database change, no backend.
User request (2026-11-25): the person getting paid (the bill's payer) can send Venmo requests to the people who owe them, for example payer `Yash-Saraiya` requests from `Tejesh-Bhaumik`. The user confirmed on iPhone that `https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=0.01&note=SplitIt` opens Venmo's Request screen, sent from whichever Venmo account is signed in on that phone (ADR 0007 note, 2026-11-25). This reverses the M3 cut ("request links, not asked for", `docs/specs/2026-11-24-m3-settle-venmo.md` Out of scope) and picks up the `IDEAS.md` line "person who posted receipts closes it out and can send venmo requests".

Decisions were delegated by the main session ("decide without asking, log each one"). They are VR-1 … VR-10 in `docs/decisions-to-review.md`. VR-5 changes what the payer can collect in one tap and is marked **Money: needs your look**.

**Amendment A1 (2026-11-25, user decisions relayed by the main session after seeing a local demo bill).** U-A confirms VR-1 and VR-4. U-B adds a direct "Pay on Venmo" footer on the bill screen for people who owe (design F1–F4 below, decisions VR-11 … VR-18). The task list and criteria below are the amended ones; Tasks 3 and 5 and criteria 23–35 are new. The note spec is built: this spec reuses `venmoNote`, `claimedItemNames` and the private `venmoLink(format, txn, input)` in `lib/paylinks.ts`, and exports `venmoRequestUrlForFormat` so V2 is testable (review nit).

**Amendment A2 (2026-11-25, code review of Tasks 1–5; main-session decisions VR-R1 … VR-R6 in `docs/decisions-to-review.md`).** Built in Task 5's fix round:
- **R1 (F2):** when the refetch after the viewer's own saved claim, split or extras change fails, the bill screen's footer keeps Pay / I paid disabled and shows `Couldn't refresh. Try again.` with **Refresh** (calls `refetch()`). Pure check `saveRefreshFailed` in `lib/settleView.ts`.
- **R2 (F2, R4):** a "Couldn't open Venmo…" line is stored with what it described and shown only while it still matches (`payOpenFailedLine`, `requestOpenFailedLine`), on the bill screen footer and on the Settle card and list. The request link model gains `userId`.
- **R3:** screen tests for live payer/share changes during "Did you pay?", and I paid disabled while a claim saves in that state.
- **R4:** `settleRequestWebLine(input, people)` takes the list already built. **R5:** `settle.tsx` calls `settleViewInputFor` directly (no `planFor`). **R6:** Q4 is decided by `isSettleCents(cents)`; any other null request link is Q2/Q3, so the username rule lives only in `venmoLink` (changes VR-I4 for a bad username *and* a share over the cap).
- Also in Task 5 (VR-I6): the bill screen's "N left to claim" still follows its optimistic counts through `billFooterAction`; Pay amounts come only from server data.

## Sequencing (blocking)
**No task here starts until Task 1 of `docs/specs/2026-11-25-venmo-note-item-names.md` is done** (merged, its criteria 1–11 passing). That task changes `lib/paylinks.ts`: `venmoNote(names)` (N2: "SplitIt: A, B + N more", 100 code points starting value, no discounts), `claimedItemNames(rows, claims, userId)` (N1), and `VenmoPayInput` gains `itemNames?: readonly string[]` (N3). `SettleViewInput` gains `viewerItemNames` (N4). This spec builds on that result:
- **One link builder.** The request link is a `txn=charge` variant of the same builder in `lib/paylinks.ts`. No second URL template, no second amount formatter, no second username check.
- **One note builder.** The request note is `venmoNote` over **the requested person's** names from `claimedItemNames(rows, claims, <their userId>)`, exactly as the pay link does for the viewer (VN-2: a person's note only ever lists their own items). No item selection, cleanup or truncation logic is copied.
- Each task below starts by re-reading the note spec and the built `lib/paylinks.ts` / `lib/settleView.ts`. If a name differs from the note spec (the implementer may have renamed something), use the built name and say so in the report.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Venmo app + the user's own Venmo account on an iPhone | User checks U1 (link opens the Request screen). Nobody presses Request | $0, already used for M3 criterion 64 |
| Android phone with Venmo (optional) | U1 on Android | $0. Not run if there isn't one |
| Local Supabase + two Google test accounts | U2 (web, two accounts) | $0, already set up |
| Venmo API, developer account, hosted Supabase, Apple Developer (paid) | **Not needed** | $0 |

Nothing new to sign up for.

## Goal
On the Settle screen, the payer sees a "Request" button next to each person who still owes them. One tap opens Venmo's Request screen with that person's Venmo username, their exact share and their items in the note, so the payer can collect without typing anything. (A1) People who owe can also pay straight from the bill screen's footer, without opening Settle up first.

## In scope
- `lib/paylinks.ts`: a `txn` choice (`pay` | `charge`) in the one builder, plus `venmoRequestUrl`.
- `lib/settleView.ts`: a per-row request model and its copy, payer view only.
- The Settle screen's Everyone list: the Request button, its handle caption, its error, and one web line.
- (A1) The bill screen's footer: a direct "Pay <Payer> $X on Venmo" for people who owe, a one-line "Did you pay?" prompt, and a "Details" link to Settle up (design F).
- Docs: ADR 0007 and 0015 notes, `docs/before-production.md`, decisions.

## Out of scope (cut)
- **"Request all"** (one button that opens several requests). Venmo opens one request per link; several `window.open`s in one tap are blocked by browsers after the first. VR-4.
- **Tracking requests** ("Requested 2 min ago"), on screen or in the database. The app can't see whether a request was sent. VR-6, VR-7.
- **An Activity event for requesting.** VR-7.
- **Requesting the difference** when someone marked "I paid" but their share changed later. VR-5.
- **The payer marking someone as paid** ("they paid my request"). Still in M3's Later list.
- Reminders, push notifications, PayPal / Cash App requests.
- Any database, RLS or grant change. Requests read only what the payer can already read: co-participants' `venmo_username` (profile spec) and the bill's claims.

## Design

### R1. The request link (shared contract; Task 1 builds it, Task 2 and Task 3 use it)
- `venmoRequestUrl(input: VenmoPayInput)` takes the **same input** as `venmoPayUrl` (`{ username, cents, itemNames? }`, note spec N3) and returns the same URL with `txn=charge` in place of `txn=pay`. Nothing else differs.
  - V1 (current `VENMO_LINK_FORMAT`): `https://venmo.com/?txn=charge&recipients=<username>&amount=<amount>&note=<note>`. **Verified on iPhone 2026-11-25** for `note=SplitIt`. Not verified on Android or desktop.
  - V2: `https://venmo.com/<username>?txn=charge&amount=<amount>&note=<note>`. **Unverified**; exists only because the format switch is shared. Not used while `VENMO_LINK_FORMAT` is `'v1'`.
- Returns `null` in exactly the cases `venmoPayUrl` does: username fails `VENMO_USERNAME_PATTERN`, cents fail C2 (integer 1 … 99,999,999).
- `<username>` here is **the person being asked** (the one who owes), not the payer. The money flows to whoever is signed into Venmo on the device that opens the link.
- `<note>` is `encodeVenmoNote(venmoNote(itemNames))` with `itemNames = claimedItemNames(data.rows, data.claims, <requested person's userId>)`. Venmo notes can be public; the note spec owns that privacy rule (VN-8, kill switch `VENMO_NOTE_INCLUDES_ITEMS`), and this spec adds no new text to the note.
- Implementation rule (A1, checked against the built file 2026-11-25): the private `venmoLink(format, txn, input)` in `lib/paylinks.ts` already takes `txn`; its type `VenmoTxn` goes from `'pay'` to `'pay' | 'charge'`. Add exported `venmoRequestUrlForFormat(format, input)` (calls `venmoLink(format, 'charge', input)`) and `venmoRequestUrl(input)` (uses `VENMO_LINK_FORMAT`). `venmoLink` stays the one function that writes `venmo.com` URLs.

### R2. Who sees a Request button (Task 2 implements; Task 3 renders)
Only when **the viewer is the payer** (`viewerId === plan.payerId`) and the plan is `ready`. The host who isn't the payer sees none (VR-2). Per row of the Everyone list:

| # | Row state | What the payer's row shows |
|---|---|---|
| Q1 | `owes`, not marked, valid Venmo username | muted `@<handle>` + ghost button **Request** (amount = `owedCents`) |
| Q2 | `owes`, not marked, no username (null) | muted caption **Hasn't added Venmo**. No button |
| Q3 | `owes`, not marked, stored username fails the pattern | same as Q2 |
| Q4 | `owes`, not marked, `owedCents` > 99,999,999 (link is null) | same as Q2's layout, caption **Request it in the Venmo app** |
| Q5 | `owes`, marked, mark = share | nothing new (row shows ✓ Paid + Undo as today) |
| Q6 | `owes`, marked, share changed (`markDiffers`) | nothing new (today's warning sub-line stays) — VR-5 |
| Q7 | `nothing` with a mark | nothing new |
| Q8 | `payer_owes_them` (negative share) | nothing new |
| Q9 | viewer isn't the payer (any row) | nothing new |
| Q10 | plan `blocked` / `blocked_all_zero` / `blocked_bad_payer` | no list (as today) |

- Amount: exactly `owedCents` from `settlePlan`. Components do no arithmetic.
- Request and Undo never show on the same row (Request needs "not marked", Undo needs "marked").
- The requested person is never the viewer (the payer has no row), so no copy needs a "You" form.
- The payer's own saved Venmo username doesn't matter (VR-8): the "Add your Venmo" card still shows above when it's missing, and the Request buttons show either way.

### R3. Copy (all in `lib/settleView.ts`)

| Key | Text |
|---|---|
| request button label | `Request` |
| request a11yLabel | `Request <amount> from <Name> on Venmo, @<handle>` e.g. `Request $15.10 from Tejesh on Venmo, @Tejesh-Bhaumik` |
| request a11yHint | `Opens Venmo` (existing `SETTLE_COPY.opensVenmo`) |
| handle caption | `@<handle>` |
| no username caption (Q2, Q3) | `Hasn't added Venmo` |
| amount too large caption (Q4) | `Request it in the Venmo app` |
| open failed (list error) | `Couldn't open Venmo. Request <amount> from @<handle> in the Venmo app.` |
| web line (payer, web, ≥ 1 Request button) | `On a computer? Send requests from the Venmo app on your phone.` |

The row's existing `a11yLabel` (`Tejesh, $15.10, not paid yet`) is unchanged; the button and captions sit outside the grouped row, as Undo does.

### R4. Screen behavior (Task 3)
- Tap **Request** → `openPaymentLink(url)` is the first call in the handler, no `await` before it (web popup rule, M3 R8). Taps within 1 s of the last one are ignored (same rule as Pay, M3-B-15).
- `{ ok: false }` → the list's error banner shows the "open failed" line. Nothing is written.
- Requesting **never** writes: no rpc, no table write, no Activity event, no local "requested" state. The row keeps "Not yet" until that person marks "I paid".
- Live updates: when a refetch shows the person marked, their row loses Request and shows ✓ Paid; when their share changes, the next tap uses the new amount and note (the model is rebuilt from the current plan each render).
- Web: same button on every platform (M3 Q8 answer). The web line in R3 shows once, under the list.

### F. Pay straight from the bill screen (Amendment A1, U-B)
**F1. Shared contract: the footer follows the Settle card.** The bill screen's footer action is derived from the **same** `settleCard(input)` the Settle page shows, so the fallbacks can't drift:
- `settleViewInputFor(data, viewerId, platform, openedVenmo)` moves from `planFor` in `app/(app)/bills/[id]/settle.tsx` into `lib/settleView.ts` (pure; `platform` passed in). Both screens call it. It is built from **server data** (`data`), never from the bill screen's optimistic claims.
- `settleFooterAction(input, participantCount)` in `lib/settleView.ts` returns:

| # | Situation | Footer |
|---|---|---|
| F-a | fewer than 2 participants | none (as today) |
| F-b | plan `blocked` (items left) | today's secondary "Settle up" + "N left to claim" (unchanged) |
| F-c | card state `owes` (viewer owes, not marked, payer's username valid, cents in C2) | **primary** button = the card's Pay button (label `Pay <Payer> $15.10 on Venmo`, same `url`, a11y label and hint), then muted notes = the card's notes (`@hana-1 · $15.10`, plus the web line on web), then a ghost **Details** link (opens Settle) |
| F-d | card state `owes_opened` (viewer tapped Pay on this screen, still matches) | one line `Did you pay <Payer>?` with **I paid** (primary) and **Not yet** (ghost), then **Details** |
| F-e | card state `marked` | primary "Settle up" (opens Settle) + muted caption `✓ Marked paid` |
| F-f | everything else: viewer is the payer; `nothing`, `negative`, `marked_changed`, `owes_no_venmo`; `blocked_all_zero`; `bad_payer` | today's primary "Settle up" (opens Settle), unchanged |

**F2. Behavior (bill screen).**
- Pay tap: `openPaymentLink(url)` is the first call, no `await` before it; then `openedVenmo` is set in the bill screen's state (not persisted; never marks). Taps within 1 s are ignored. `{ ok: false }` shows the card's existing `openFailedText(handle, cents)` under the footer.
- No app-state / visibility listening (M3-UX-1): the "Did you pay?" line is simply there when they come back.
- **I paid** → `markPaid(billId, payerId, cents)` with the opened payer and cents, button loading until the refetch that includes it has finished (landed or failed; same `version`/`finished` rule as the Settle page). Error → `actionError(...)` text under the footer. **Not yet** → clears `openedVenmo` (back to F-c). If a refetch makes the opened payer/amount stale (`openedStillMatches` false), `openedVenmo` is dropped, as on Settle.
- While any of the viewer's claim, split or extras-mode writes is in flight, the F-c / F-d buttons are disabled (the amount must come from committed data).
- "I already paid" (cash, other apps) stays on the Settle page only, reached through Details.

**F3. Copy.** New: `Details` (a11y label `Settle up details`, hint `Shows who's paid and other ways to pay`). Everything else reuses `SETTLE_COPY` / `payButtonText` / `handleLine` / `didYouPay` / `openFailedText` / `actionError`; `Not yet` is the existing `SETTLE_COPY.rowNotYet` text. The payer is never the viewer in F-c/F-d, so no "You" form is needed.

**F4. Kept unchanged.** The Settle page (its card still has Pay and "I already paid"), M3's footer for every non-ower, and the existing footer tests: the `__tests__/billScreen.test.tsx` fixture's payer has `venmo_username: null` (line 73), so the guest case at lines 728–743 is F-f and still opens `/bills/<id>/settle`.

## Tasks
All in `splitit-app`. **Start only after the note task is done** (done 2026-11-25, review-approved). Order: 1 → 2 → 3 (same file as 2, so after it) → 4 and 5 (can run in parallel; different files) → 6.

1. **Request link builder** — `implementer`. Files: `lib/paylinks.ts`, `lib/paylinks.test.ts`. Per R1 (A1 implementation rule): widen `VenmoTxn`, export `venmoRequestUrlForFormat` and `venmoRequestUrl`. Update the header comment. ~60 lines. Criteria 1–5.
2. **Request row model** — `implementer`. Files: `lib/settleView.ts`, `lib/settleView.test.ts`. Add to `SettleRowModel` a `request` field (`{ url, cents, handle, label, a11yLabel, a11yHint } | { caption } | null`, exact shape the implementer's), the R3 copy, `requestOpenFailedText(handle, cents)` and a `settleRequestWebLine(input)` (string or null). `SettleViewInput` gains two **required** lookups: `venmoOf: (userId: string) => string | null` and `itemNamesOf: (userId: string) => readonly string[]` (names suggested; the existing `viewerItemNames` stays as the note spec left it). `rowFor` passes `itemNamesOf(e.userId)` as `itemNames` to `venmoRequestUrl`. Update the `view()` test helper with defaults (`() => null`, `() => []`); no existing assertion changes. ~150 lines. Criteria 6–12.
3. **Shared view input + footer model** — `implementer`. Files: `lib/settleView.ts`, `lib/settleView.test.ts`. Add `settleViewInputFor` (F1; it builds `venmoOf`, `itemNamesOf` via `claimedItemNames`, `viewerItemNames`, marks, payer) and `settleFooterAction` (F1 table), plus F3 copy. Keep `settleFooter` working for its current callers until Task 5 switches. ~180 lines. Criteria 23–28.
4. **Settle screen: Request buttons** — `product-engineer` (loads `ui-ux-designer`). Files: `app/(app)/bills/[id]/settle.tsx`, `components/SettlePeopleList.tsx`, `__tests__/settle.test.tsx`. Replace `planFor`'s body with `settleViewInputFor`; render R2/R3; handle the tap per R4. Note spec criterion 9 (`claimedItemNames` only in `settle.tsx` among `app components`) moves with it: the call now lives in `lib/settleView.ts`, so that grep matches nothing in `app components`; report it as expected wording drift, not a failure. ~180 lines. Criteria 13–20.
5. **Bill screen: pay from the footer** — `product-engineer` (loads `ui-ux-designer`). Files: `app/(app)/bills/[id]/index.tsx`, a new `components/SettleFooter.tsx` (the footer row, so `index.tsx` doesn't grow), `__tests__/billScreen.test.tsx`. Render `settleFooterAction` (F1) with F2 behavior. ~250 lines. Criteria 29–35.
6. **Docs** — `docs-writer`. Files: `docs/learning/decisions/0007-payment-deep-links.md` (dated note: request links built, which formats are verified), `docs/learning/decisions/0015-settling-one-payer-self-reported-marks.md` (dated note: owers can pay from the bill screen; marks unchanged), `docs/before-production.md` (items below), `docs/decisions-to-review.md` (update VR rows). Criterion 21.

## Acceptance criteria

### Link (Task 1, `lib/paylinks.test.ts`)
1. `venmoRequestUrl({ username: 'Tejesh-Bhaumik', cents: 1, itemNames: [] })` and the same without `itemNames` are exactly `https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=0.01&note=SplitIt` (the URL the user confirmed). With `itemNames: ['Carnitas Bowl', 'Chicken Burrito', 'Chips']` and `cents: 1510` it is exactly `https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=15.10&note=SplitIt%3A%20Carnitas%20Bowl%2C%20Chicken%20Burrito%20%2B%201%20more` (note spec criterion 4's note, B3).
2. Same-input equivalence, both formats: for every input in a fixed table (valid, each invalid username, each C2 boundary below, note spec rows B1, B9, B15, B17, B18 as `itemNames`) and for 200 seeded random inputs (random `itemNames` as in note spec criterion 2), `requestUrl(fmt, x) === payUrl(fmt, x)?.replace('txn=pay', 'txn=charge') ?? null`, where `fmt` is `'v1'` and `'v2'`.
3. Amount boundaries (C2): cents `1` → `amount=0.01`; `99999999` → `amount=999999.99`; `0`, `100000000`, `-5`, `12.5`, `NaN` → `null`. Username boundaries: 5 and 30 characters → URL; 4 and 31 characters, `'@hana-1'`, `'ab cd'`, `null` → `null`.
4. `venmoRequestUrl(x)` equals the request URL in `VENMO_LINK_FORMAT` (`'v1'` today).
5. One builder: `grep -rn "venmo\.com" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/paylinks.ts`, and `grep -rn "txn=" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/paylinks.ts`. *(Run today with the Grep tool over the same paths, tests included: both match `lib/paylinks.ts` and `lib/paylinks.test.ts` only.)* The reviewer also checks that `lib/paylinks.ts` has a single template that writes `venmo.com` URLs per format (V1, V2), shared by pay and request.

### Row model (Task 2, `lib/settleView.test.ts`)
6. For a ready plan viewed by the payer, each R2 case Q1–Q8 gives exactly the row content in the R2 table (one test per row; Q6 uses a mark of 500 with a share of 700 and a mark of 700 with a share of 500).
7. Q1's `request.url` equals `venmoRequestUrl({ username: venmoOf(B), cents: owedCents, itemNames: itemNamesOf(B) })`. Test with two owers whose items differ (`itemNamesOf`: B → `['Pad Thai']`, D → `['Beer']`, payer A → `['Burger']`): B's decoded note is `SplitIt: Pad Thai`, D's is `SplitIt: Beer`, and neither contains `Burger`. Also on the screen (criterion 17's fixture): the decoded note of B's request contains no participant name and no amount.
8. Q1's `request.cents === owedCents` at 1¢ and at 99,999,999¢; at 100,000,000¢ the row is Q4 (caption, no URL).
9. Q9: the same bill viewed by the host who isn't the payer, and by an ower, has `request === null` on every row. Q10: blocked plans still return `null` from `settlePeople`.
10. Copy: every R3 string is asserted exactly, including the a11y label for `Tejesh` / `@Tejesh-Bhaumik` / 1510¢ (`Request $15.10 from Tejesh on Venmo, @Tejesh-Bhaumik`) and the open-failed line for the same (`Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.`).
11. `settleRequestWebLine` returns the R3 web line only when platform is `'web'`, the viewer is the payer, and at least one row has a Request URL; `null` on `'ios'`/`'android'`, for non-payers, and when every ower is marked or has no username.
12. Every assertion in `lib/settleView.test.ts` that existed before this task still passes unchanged; only the `view()` helper's input gains fields. (Searched today: the row assertions at `lib/settleView.test.ts:351-354` check name, amount, status and `a11yLabel`, which this spec doesn't change.)

### Settle screen (Task 4, `__tests__/settle.test.tsx`; native and `Platform.OS = 'web'` each)
13. As the payer with B unmarked and `venmoUsername: 'Tejesh-Bhaumik'`, tapping B's Request calls `openPaymentLink` once with the row model's URL, and the call happens before any awaited work in the handler (assert the mock was called synchronously after `fireEvent.press`).
14. Two taps within 1 s call `openPaymentLink` once; a tap after 1 s (fake timers) calls it again.
15. When `openPaymentLink` resolves `{ ok: false }`, the Everyone card shows `Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.`
16. Requesting writes nothing: after the tap, the fake Supabase client has recorded no `rpc` call and no `insert` / `update` / `delete` / `upsert` on any table, and B's row still shows `Not yet`.
17. After a refetch where B is marked (500¢), B's Request button is gone and `✓ Paid` shows; after a refetch where B's share changes from 1510¢ to 1620¢ (unmarked), the next tap opens the URL with `amount=16.20`.
18. Signed in as the host who isn't the payer, and as B, the screen shows no button with label `Request` (`queryAllByText('Request')` is empty).
19. The Request button has `accessibilityLabel` from the row model and `accessibilityHint` `Opens Venmo`; B's grouped row label is still `Tejesh, $15.10, not paid yet` (or the fixture's names).
20. On web as the payer with one Request button, the R3 web line is visible once; on native it isn't.

### Whole slice
21. Docs: ADR 0007 has a dated note saying request links are built (V1 `txn=charge`, iPhone verified 2026-11-25; V2, Android and desktop unverified); `docs/before-production.md` has the two items below; the VR rows' Status is updated.
22. `npm run typecheck` and `npm test -- --maxWorkers=4` pass. No file under `supabase/` is created or changed by this slice (the reviewer lists `supabase/migrations/` and `supabase/tests/database/` by modification time).

### Footer model (Task 3, `lib/settleView.test.ts`)
23. `settleViewInputFor` gives the same `SettleViewInput` the Settle page built before (same plan, names, payer, `payerVenmo`, `viewerMarked`, `viewerItemNames`) on the existing settle fixtures; `lib/settleView.test.ts` and `__tests__/settle.test.tsx` pass with no assertion changes.
24. `settleFooterAction` returns each F1 row F-a … F-f on a fixture per row (F-f: one test each for viewer = payer, `nothing`, `negative`, `marked_changed`, `owes_no_venmo` with null username and with `'ab'`, `blocked_all_zero`, `bad_payer`).
25. F-c's button `action` is identical (`toEqual`) to `settleCard(input).primary.action` for the same input, and its notes equal `settleCard(input).notes` (on `'web'` they include `On a computer? Send it from the Venmo app on your phone.`; on `'ios'` they don't).
26. F-c's URL is exactly `https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries` on the note spec's worked fixture (Sam viewing), the same literal as note spec criterion 7.
27. F-c amount boundaries: owed 1¢ → F-c with `amount=0.01`; owed 99,999,999¢ → F-c; owed 100,000,000¢ → F-f (the card has no Pay link there).
28. F-d appears only when `openedVenmo` matches the payer and `owedCents`; after the payer changes or the share changes, the same input gives F-c (or F-f), never F-d.

### Bill screen (Task 5, `__tests__/billScreen.test.tsx`; native and `Platform.OS = 'web'` each)
29. Fixture with payer A's `venmo_username: 'hana-1'`, everything claimed, viewer B owing: the footer's primary button reads `Pay Hana Lee $X on Venmo` per the fixture (exact string from `payButtonText`), `@hana-1 · $X` shows under it, and **Details** is present. Tapping Pay calls `openPaymentLink` once, synchronously, with the F-c URL, and the route stays `/bills/<id>` (no navigation).
30. Two taps within 1 s open once. `{ ok: false }` shows `Couldn't open Venmo. Send $X to @hana-1 in the Venmo app.`
31. After the Pay tap, the footer shows `Did you pay Hana Lee?` with I paid and Not yet. Not yet → Pay button again, no rpc call. I paid → exactly one `rpc('mark_paid', { p_bill_id, p_payer_id: A, p_cents: <owed> })`; after the refetch with B marked, the footer is F-e (`Settle up` + `✓ Marked paid`). A failed `mark_paid` (`payer_changed`) shows its `actionError` text and re-enables the buttons; a failed refetch also re-enables them.
32. Tapping Pay writes nothing: before I paid, the fake client has no `rpc` / insert / update / delete call from the tap.
33. Details opens `/bills/<id>/settle`. On that page B still sees Pay and "I already paid".
34. Fallbacks open Settle, not Venmo: as payer A; as B with payer `venmo_username: null` (the existing test at lines 728–743, unchanged); as B already marked; with one item unclaimed (the existing secondary-button test, unchanged).
35. While B's claim toggle is in flight on the complete bill, the Pay button is disabled; once it settles, the amount shown is from the refetched data.

### User checks (need a person)
- **U1 (iPhone, no backend needed).** QA prints `venmoRequestUrl` for a username the user gives (ask; don't read `.env*`) at 1¢, once with `itemNames: ['Carnitas Bowl', 'Chicken Burrito']` and once with the note spec's U-1 list (a) (five names, "+ 3 more"). Can run in the same sitting as the note spec's U-1. The user opens each from Notes or Messages with Venmo installed. Expected: Venmo's **Request** screen, recipient, `$0.01` and the note filled in. **Don't press Request.** Record what shows; repeat on Android if available, and open one link in a desktop browser to record what venmo.com does (desktop is unverified for both pay and request).
- **U2 (web, two accounts, local Supabase).** A (payer) and B claim a bill to complete; A opens Settle up. B's row shows `@<B's handle>` and Request. Tap it: a new tab opens at the exact R1 URL with B's items in the note. B taps "I paid": within a few seconds A's row shows ✓ Paid and the Request button is gone. B, on their own Settle screen, sees no Request buttons.
- **U4 (web, two accounts; A1).** B opens the complete bill: the footer reads `Pay A $X on Venmo` with `@handle · $X`. Tap it: a new tab opens at the pay URL (check Safari's popup behavior too, per the existing before-production item). Back in the SplitIt tab, `Did you pay A?` shows; tap I paid: within a few seconds A's Settle page shows B as ✓ Paid, and B's footer reads `Settle up` with `✓ Marked paid`. Judge whether the footer feels uncluttered (button, one handle line, Details).
- **U3 (VoiceOver, iOS simulator).** On A's Settle screen, VoiceOver reads B's row as before, then the button as `Request $15.10 from <B> on Venmo, @<handle>`, hint `Opens Venmo`.
- **In-app check on a physical phone: blocked.** On the phone, `127.0.0.1` is the phone itself; it waits for the hosted deploy or the Mac's LAN IP plus matching Supabase/Google redirect URLs. U1 covers the Venmo side without the backend.

## Before-production items (Task 4)
- **§5 (Venmo link check):** extend the existing item: the request form (`txn=charge`) is verified on iPhone only (2026-11-25). Re-run U1 on Android and desktop and before launch, alongside the pay check.
- **§6 Privacy:** add one line to the "Venmo notes can be public" item (as rewritten by the note spec's Task 2): a request's note carries the requested person's item names, written by the payer's device, and whether a completed request shows on a public feed the way a payment does is *unverified*. Don't add a separate item.
- **§5 (Safari popup item, A1):** extend it to the bill screen's footer Pay button (same `openPaymentLink`, same fallback handle line).
- **§6:** a request comes from whichever Venmo account is signed in on the device that opens it, not from the payer's saved username. On a shared or borrowed phone it asks money for someone else. Low risk among friends; note it in help text if it confuses people.

## Risks / open questions
- **Depends on the note task's final shape.** If the built `claimedItemNames` / `itemNames` differ from the note spec's N1/N3, Task 2 uses what was built; if it can't get a per-person name list from `BillData` that way, it stops and reports instead of re-deriving item names.
- **Note spec criterion 9** says `claimedItemNames` appears only in `app/(app)/bills/[id]/settle.tsx` among `app components`; Task 3 keeps it there (inside `planFor`), so that criterion stays true.
- **Desktop and Android behavior of `txn=charge` is unverified** (U1). The button shows on every platform anyway (VR-9).
- **VR-5, Money: needs your look.** A person who marked "I paid" but whose share later grew gets no Request for the difference; the existing "Marked $5.00 · share now $7.00 ⚠" line stays. Easiest to reverse: adding a "Request $2.00" there is a Task 2 + Task 3 change, no DB.
- No open questions block the build.
