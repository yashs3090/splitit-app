# Venmo note: "SplitIt" plus the payer's item names

Date: 2026-11-25. Request (user): "can you add splitit + the items name in the note please".
Builds on: `docs/specs/2026-11-24-m3-settle-venmo.md` (C5, Q7, criterion 64), ADR 0007, ADR 0015.
Decisions: user decisions U1–U5 (below) plus PM decisions VN-1 … VN-11, logged in `docs/decisions-to-review.md` § "2026-11-25 · Venmo note with item names".

## Goal
When someone taps "Pay <payer> $X on Venmo", the Venmo Pay screen opens with a note that says what they're paying for, e.g. `SplitIt: Carnitas Bowl, Chicken Burrito + 3 more`. Today it always says `SplitIt`, so the payer can't tell payments from the same bill apart in Venmo.

## Providers, accounts and costs
| Service / account | Used for | Setup cost | New in this spec? |
|---|---|---|---|
| Venmo (the payer's and recipient's own accounts) | Opening the pre-filled Pay screen via an https link (ADR 0007) | None for us | No |
| Apple iPhone with Venmo installed (the user's) | User check U-1 | None (already used for criterion 64) | No |

No backend change, no migration, no new package.

## User decisions (2026-11-25, relayed by the main session; recorded as decided by the user)
- **U1.** Shared items are included.
- **U2.** Claimable discounts do not appear in the note.
- **U3.** At most 2 item names, then `+ N more` for the rest (e.g. `SplitIt: Carnitas Bowl, Chicken Burrito + 3 more`).
- **U4.** If the length limit is hit before 2 names fit, include as many whole names as fit, then `+ N more`.
- **U5.** If a single name is too long, truncate it so the note fits (still followed by `+ N more` if others remain).

## In scope
- A pure note builder `venmoNote(names)` and a pure selector `claimedItemNames(rows, claims, userId)`, both in `lib/paylinks.ts`, with tests.
- `venmoPayUrlForFormat` / `venmoPayUrl` take the item names and build the note themselves (still no free-form note from callers).
- The Settle screen passes the viewer's claimed item names through `SettleViewInput`. No visible UI or copy change on the screen.
- One-line kill switch `VENMO_NOTE_INCLUDES_ITEMS` (back to plain `SplitIt`).
- Docs: before-production privacy item, ADR 0015 note line, catches.md line, a dated pointer in the M3 spec's C5/Q7.

## Out of scope
- Showing the note on the Settle screen (VN-9).
- Quantities ("2× Margarita") (VN-3).
- Restaurant name, date, amounts or people's names in the note.
- A per-user or per-bill setting for the note (the kill switch is code-only).
- PayPal / Cash App links; `audience=private` (still unverified, M3 C5).
- Any DB change.

## Shared contract (defined once; Task 1 implements it, Task 1's screen wiring and every criterion point here)

**N1. Which names: `claimedItemNames(rows, claims, userId): string[]`**
- `rows`: `readonly { id: string; name: string; kind?: 'item' | 'discount' }[]`, in the order given (fetchBill's order: `group_position`, then `unit_index`). `claims`: `readonly { line_item_id: string; user_id: string; parts: number }[]`.
- Returns `row.name` (raw, uncleaned) for every row, in row order, where `row.kind !== 'discount'` (absent = item; U2) and some claim has `line_item_id === row.id`, `user_id === userId` and `parts >= 1`. A shared row (several claimers) counts (U1). Unit rows of a qty>1 item each appear once per claimed unit (de-duplicated in N2).
- Other users' claims never contribute. No display names, no amounts.

**N2. The note: `venmoNote(names: readonly string[]): string`**
1. If `VENMO_NOTE_INCLUDES_ITEMS` is `false`, return `SETTLE_NOTE` (`'SplitIt'`).
2. Clean each name: replace every lone UTF-16 surrogate with U+FFFD; replace each run of whitespace (`/\s+/u`) with one space; trim. Drop empty results.
3. De-duplicate by exact cleaned text (case-sensitive), keeping the first occurrence's position. `n` = number left.
4. If `n === 0`, return `'SplitIt'`.
5. `prefix = 'SplitIt: '`; `sep = ', '`; `suffix(m) = m > 0 ? \` + ${m} more\` : ''` (space, plus, space, number, space, "more").
6. For `k = min(2, n)` down to `1`: `candidate = prefix + first k names joined by sep + suffix(n - k)`. Return the first candidate with `len(candidate) <= VENMO_NOTE_MAX` (U3, U4).
7. Otherwise (the first name alone doesn't fit, U5): return `prefix + clip(name₀) + '…' + suffix(n - 1)`, where `clip` keeps the first code points of name₀ so the whole result is exactly `VENMO_NOTE_MAX` long. `'…'` is U+2026 (one code point).
- `len` counts **Unicode code points** (`Array.from(s).length`); clipping never splits a surrogate pair.
- `VENMO_NOTE_MAX = 100` (**starting value**). Venmo's help center says "Payment notes are limited to 280 characters" (checked 2026-11-25, https://help.venmo.com/hc/en-us/articles/115004757928-Customize-Your-Payment). How Venmo counts emoji, and whether a link-prefilled note is cut differently, is **unverified**; 100 leaves room. The implementer may change it with evidence.
- Never throws, for any array of strings.

**N3. The URL.** `VenmoPayInput = { username: string | null; cents: number; itemNames?: readonly string[] }` (absent = `[]`). The `note` parameter is `encodeURIComponent(venmoNote(itemNames ?? []))` via `encodeVenmoNote`. Everything else in C5 (formats, username and amount rules, null cases) is unchanged. An extra `note` field on the input is still ignored.

**N4. Wiring.** `SettleViewInput` gains a **required** `viewerItemNames: readonly string[]`. `planFor` in `app/(app)/bills/[id]/settle.tsx` sets it to `claimedItemNames(data.rows, data.claims, myId)`. `oweCard` in `lib/settleView.ts` passes it as `itemNames` to `venmoPayUrl`; the primary Pay action and "Open Venmo again" carry the same URL. Components and routes do no string building for the note.

### Boundary cases (both the `venmoNote` tests and, where noted, the URL tests use these)
`a44` means `'a'.repeat(44)`, etc. Lengths are code points.

| # | names in | note out | length |
|---|---|---|---|
| B1 | `[]` | `SplitIt` | 7 |
| B2 (exactly 2) | `['Carnitas Bowl', 'Chicken Burrito']` | `SplitIt: Carnitas Bowl, Chicken Burrito` | 39 |
| B3 (3 items) | B2 + `'Chips'` | `SplitIt: Carnitas Bowl, Chicken Burrito + 1 more` | 48 |
| B4 (5 items) | B2 + `'Chips', 'Guac', 'Horchata'` | `SplitIt: Carnitas Bowl, Chicken Burrito + 3 more` | 48 |
| B5 (unit rows) | `['Margarita', 'Margarita', 'Nachos']` | `SplitIt: Margarita, Nachos` | 26 |
| B6 (blank) | `['  ', '', '\n']` | `SplitIt` | 7 |
| B7 (whitespace) | `['  Fish \n Tacos  ']` | `SplitIt: Fish Tacos` | 19 |
| B8 (one name, limit exactly reached) | `[x91]` | `SplitIt: ` + x91 | 100 |
| B9 (one name, 1 over) | `[x92]` | `SplitIt: ` + x90 + `…` | 100 |
| B10 (two names, limit exactly reached) | `[a44, b45]` | `SplitIt: ` + a44 + `, ` + b45 | 100 |
| B11 (second name doesn't fit) | `[a44, b46]` | `SplitIt: ` + a44 + ` + 1 more` | 62 |
| B12 (3 names, limit exactly reached with suffix) | `[a40, b40, 'Chips']` | `SplitIt: ` + a40 + `, ` + b40 + ` + 1 more` | 100 |
| B13 (3 names, second 1 over) | `[a40, b41, 'Chips']` | `SplitIt: ` + a40 + ` + 2 more` | 58 |
| B14 (first name alone fits exactly with suffix; two don't fit) | `[x82, b20]` | `SplitIt: ` + x82 + ` + 1 more` | 100 |
| B15 (first name alone over the limit, others remain) | `[x83, b20]` | `SplitIt: ` + x81 + `…` + ` + 1 more` | 100 |
| B15b (two short names still fit after a long first one) | `[x82, 'Fries']` | `SplitIt: ` + x82 + `, Fries` | 98 |
| B16 (first name alone over, no others) | `[x200]` | `SplitIt: ` + x90 + `…` | 100 |
| B17 (emoji, clip doesn't split pairs) | `['🌮'.repeat(95)]` | `SplitIt: ` + 90 × `🌮` + `…` | 100 |
| B18 (lone surrogate) | `['\uD800Fries']` | `SplitIt: �Fries` | 15 |
| B19 (comma inside a name) | `['Mac, Cheese']` | `SplitIt: Mac, Cheese` | 20 |
| B20 (kill switch off) | B2 with `VENMO_NOTE_INCLUDES_ITEMS = false` | `SplitIt` | 7 |

## Tasks

### Task 1 (implementer): note builder, selector, URL and Settle wiring
Repo: `splitit-app`. Roughly 200 lines with tests.
- `lib/paylinks.ts`: add `VENMO_NOTE_MAX`, `VENMO_NOTE_INCLUDES_ITEMS`, `venmoNote`, `claimedItemNames` (N1, N2); extend `VenmoPayInput` and `venmoPayUrlForFormat` (N3). Rewrite the `SETTLE_NOTE` doc comment (it now reads "never contains item names"): `SETTLE_NOTE` stays `'SplitIt'` and is the prefix and the fallback. The B20 test needs the switch to be testable; either export a `venmoNoteWith(names, includeItems)` used by `venmoNote`, or test via `jest.isolateModules` with a mocked constant. Implementer's choice; say which. Don't use regex lookbehind for surrogate handling (Hermes support unverified); loop over code units instead.
- `lib/paylinks.test.ts`: B1–B20; N1 cases (criterion 3); URL cases (criterion 4).
- `lib/settleView.ts`: `viewerItemNames` on `SettleViewInput`; `oweCard` passes it (N4).
- `lib/settleView.test.ts`: the `view()` helper defaults `viewerItemNames: []` (existing URL expectations at line 92 stay valid); add criterion 6's case.
- `app/(app)/bills/[id]/settle.tsx`: `planFor` sets `viewerItemNames` (N4). No JSX change.
- `__tests__/settle.test.tsx`: update the two assertions at lines 327 and 943 that expect `venmoPayUrl({ username: 'hana-1', cents: 1510 })` (they assert the old fixed note and will fail) to the literal URL in criterion 7.

### Task 2 (docs-writer): docs and the privacy item
Runs after Task 1 lands. Re-read each target file before editing.
- `docs/before-production.md` § 6, item "Venmo notes can be public": rewrite it to say the note now contains the payer's own claimed item names (no people's names or amounts), at most 2 names, `VENMO_NOTE_MAX` code points; item names reveal what someone ordered on a feed that can be public; the payer can edit or delete the note in Venmo before paying (**if** U-1 confirms it's editable); the one-line kill switch `VENMO_NOTE_INCLUDES_ITEMS`; list "item names in payment notes" in the privacy policy. Cite `lib/paylinks.ts` `venmoNote` (symbol, not line number).
- `docs/learning/decisions/0015-settling-one-payer-self-reported-marks.md`: replace the "fixed word SplitIt" line with a dated update pointing to this spec.
- `docs/learning/catches.md`: update the "Venmo notes can be public, so ours just says SplitIt" sentence.
- `docs/specs/2026-11-24-m3-settle-venmo.md`: add one dated line under C5's `<note>` bullet and under the Q7 answer: "Superseded 2026-11-25 by docs/specs/2026-11-25-venmo-note-item-names.md". Don't edit other text.
- Report each bullet as done or skipped with a reason.

## Acceptance criteria

### Note builder (Task 1)
1. `venmoNote` returns exactly the "note out" of every row B1–B20 (B15b included), and its result for every row has the listed code-point length. Unit tests in `lib/paylinks.test.ts`, one assertion per row.
2. For 500 seeded random name lists (0–10 names, each 0–150 code points, including spaces, commas, `+`, `&`, `#`, `%`, emoji, astral characters and lone surrogates), `venmoNote` doesn't throw, the result is at most `VENMO_NOTE_MAX` code points, starts with `SplitIt`, contains at most 2 names, `encodeURIComponent(result)` doesn't throw, and when the input has `n` distinct cleaned names and the result shows `k`, the result ends with ` + ${n-k} more` exactly when `n > k`.
3. `claimedItemNames` (N1), tested on the M3 worked bill (Burger: Hana; Salad: Sam; Fries: Hana + Sam) plus extra rows:
   - Sam → `['Salad', 'Fries']`; Hana → `['Burger', 'Fries']` (shared included, U1).
   - A discount row (`kind: 'discount'`) claimed by Sam isn't returned (U2).
   - Two unit rows "Margarita" (same group), both claimed by Sam → `['Margarita', 'Margarita']`; one claimed → `['Margarita']`.
   - A user with no claims → `[]`. A claim with `parts: 0` doesn't count.
   - Order follows `rows`, not `claims` (claims given in reverse order give the same result).
4. URL (N3), V1 and V2 both tested:
   - `venmoPayUrl({ username: 'hana-1', cents: 1510, itemNames: ['Carnitas Bowl', 'Chicken Burrito', 'Chips'] })` is exactly `https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Carnitas%20Bowl%2C%20Chicken%20Burrito%20%2B%201%20more`, and the V2 form ends with the same `&note=…`.
   - `new URL(url).searchParams.get('note')` returns the B3 text exactly (spaces aren't `+`).
   - Without `itemNames`, and with `itemNames: []`, the URLs are unchanged from today (`…&note=SplitIt`): existing criterion 25 tests pass without edits.
   - The existing "ignores any extra note field" test passes without edits.
   - Null cases (bad username, cents outside C2) still return null when `itemNames` is non-empty.
5. Only `lib/paylinks.ts` builds the note: `grep -rnE "venmoNote|encodeVenmoNote|encodeURIComponent|SETTLE_NOTE" app components` prints nothing. (Run with the Grep tool on 2026-11-25 over `app/` and `components/`: no matches today.)

### Settle wiring (Task 1)
6. `lib/settleView.test.ts`: with the worked bill, viewer Sam and `viewerItemNames: ['Salad', 'Fries']`, `settleCard(...)` gives a primary `pay` action whose `url` is `venmoPayUrl({ username: 'hana-1', cents: 1510, itemNames: ['Salad', 'Fries'] })`; with `openedVenmo` set, the "Open Venmo again" action has the same `url`. The `nothing`, `negative`, `owes_no_venmo` and payer cards are unchanged (existing tests pass with the `view()` default `[]`).
7. `__tests__/settle.test.tsx`: with the screen fixture (Sam viewing; Sam claims Salad and shares Fries), tapping Pay calls `openPaymentLink` with exactly `https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries`, on native (line 327's test) and on web (line 943's test). Both assertions use this literal, not a `venmoPayUrl(...)` call.
8. Privacy, in the screen test of criterion 7: the decoded `note` parameter contains neither `Hana` nor `Sam` nor `15.10`. Plus one screen test on the fixture with the claimable discount "Police comp" (the existing test near line 457) where Sam claims it: the decoded note doesn't contain `Police comp`.
9. `grep -rn "claimedItemNames" app components` matches only `app/(app)/bills/[id]/settle.tsx` (not run: the symbol doesn't exist yet; the implementer runs it after the change).
10. No visible change on the Settle screen: every existing `__tests__/settle.test.tsx` text and label assertion passes without edits (only the two URL assertions of criterion 7 change).
11. `npm run typecheck` passes; `npx jest lib/paylinks.test.ts lib/settleView.test.ts __tests__/settle.test.tsx` passes; `npm test -- --maxWorkers=4` passes (failures only in files this task didn't touch are reported per the parallel-work rule).

### Docs (Task 2)
12. Each Task 2 bullet is done or reported skipped with a reason; `docs/before-production.md`'s "Venmo notes can be public" item no longer says the note has "no … items".

### User check (needs the user's iPhone; no backend needed)
13. **User check U-1 (re-run of criterion 64 with a real note).** Agents: print the three links below with `npx jest` or a scratchpad script calling `venmoPayUrl` with the user's own Venmo username (ask the user for it; don't read `.env*`), `cents: 1`, and these `itemNames`:
    - (a) `['Carnitas Bowl', 'Chicken Burrito', 'Chips', 'Guac', 'Horchata']` → note `SplitIt: Carnitas Bowl, Chicken Burrito + 3 more`
    - (b) `['Mac, Cheese', 'Fish & Chips 🌮']` → note `SplitIt: Mac, Cheese, Fish & Chips 🌮`
    - (c) `[x200]` → the B16 note (to see how a 100-character note shows).
    The user opens each from Notes or Messages on the iPhone with Venmo installed. **Don't press Pay.** Record for each: does the note read exactly as above (spaces as spaces, not `+` or `%20`; `,`, `:`, `&`, `+` and the emoji shown as typed)? Is the whole note shown? Can the note be edited or cleared before paying? Are recipient and $0.01 still filled in?
    If any link shows encoded characters or a missing note, stop: QA reports it and the main session asks the user (options: set `VENMO_NOTE_INCLUDES_ITEMS = false`, or change the encoding).

## Risks / open questions
- **Privacy (needs your look, VN-8).** The note now shows what the person ordered, and Venmo payments can be public depending on each person's Venmo privacy setting. Default built: item names on, as you asked, behind `VENMO_NOTE_INCLUDES_ITEMS`. Alternatives: off by default; a "Show items in Venmo note" toggle per person. The before-production item is updated (Task 2).
- **Unverified Venmo behaviour.** How a link-prefilled note handles `%2B`, emoji and 100 characters, and whether it's editable, is unchecked until U-1. The 280-character limit is documented by Venmo's help center; how it counts emoji isn't.
- **Stale names.** If items change between opening Venmo and paying, the note shows the names from when Pay was tapped. Harmless: amounts are already handled by the "Did you pay?" match on cents.
- No open product questions block the build.
