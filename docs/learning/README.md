# Learning notes

Study material for the important ideas behind SplitIt: why we chose what we chose, how the system fits together, and the engineering concepts a junior engineer should understand to work on it. These notes are added to as the app is built (step 5 of the `build-task` skill).

**Start here:** [Important catches and caveats](catches.md): one page of the things that are easy to get wrong, with links to the full notes.

## Suggested reading order
1. [Architecture overview](concepts/architecture-overview.md): the big picture, including managed vs. custom backend
2. [Design decisions](decisions/README.md): why each major choice was made (ADRs)
3. [Database design](concepts/database-design.md): tables, keys, relationships, migrations
4. [Row Level Security](concepts/row-level-security.md): authorization inside the database, including ledger tables nobody writes directly, not even `service_role`, and usernames (a column co-people can read but only an RPC can write)
5. [Database functions](concepts/database-functions.md): security definer vs invoker, why our write paths are SQL functions, row locks (`for update` vs `for share` vs `for no key update`), one lock order per bill (the deadlock review R1 fixed), why `settle_state` is one SQL statement (one snapshot), the Sent via Venmo functions (`mark_paid`'s `created`, `mark_not_received`, one list of payment methods in `private.is_payment_method`, and why a function in a CHECK locks other roles out), and the Who paid ledger functions (a trigger that makes payments immutable, `pair_state` with a window sum, `clock_timestamp()`, redefining a helper instead of every caller, and a `BEFORE DELETE` trigger because cascades run first), and `set_username` (turning a constraint name into an error code), and deleting a group (a child-first delete order because RESTRICT is checked at each row, and the money writes locking the group first so a clash is refused instead of deadlocking)
6. [Money and rounding](concepts/money-and-rounding.md): integer cents, largest-remainder allocation, unit rows, proportional vs equal extras, who owes the payer when settling up, why paying early is safe in proportional mode (at most 1¢ of rounding), paying a difference and the 1¢ tolerance, discounts people claim like items (negative shares), and several payers' amounts adding up exactly (rule W)
7. [Auth and deep links](concepts/auth-and-deep-links.md): sign-in, sessions, invite links, how Google and Supabase fit together, the two redirect allow-lists, PKCE, the "stuck on localhost" debugging story, and the tabs under every pushed screen (the `(tabs)` anchor, `withAnchor` on `/b` and `/g`, `backToTabs`)
8. [Environment variables and secrets](concepts/env-vars-and-secrets.md): what is public, what is secret, and build-time inlining
9. [On-device text recognition (OCR)](concepts/on-device-ocr.md): reading a receipt photo on the phone, why text isn't meaning, and the parser's rules for quantities, prices and totals
10. [The scan pipeline](concepts/scan-pipeline.md): locate → crop → size → enhance → read → check, one retry, "Retake photo / Type it in"; why geometry and scale beat filters, why never black-and-white, and how tuning vs held-out receipts decide what ships (ADRs 0018, 0019)
11. [Realtime](concepts/realtime.md): live claiming between phones with data-free broadcasts, and debouncing them into one refetch
12. [Stale-state checks](concepts/stale-state-checks.md): optimistic concurrency, or "send what you saw, and let the database refuse if it changed"; idempotent retries, what an amount token can't catch, amount + time as a version ("Not received"), why a stale plan key re-plans instead of refusing, late answers after a timeout (the Who paid page), and a whole-state token (the money fingerprint that guards deleting a group)
13. [Audit log](concepts/audit-log.md): the append-only Activity timeline
14. [Testing strategy](concepts/testing-strategy.md): what to test and how, including measuring a change on real receipts
15. [People and membership](concepts/people-and-membership.md): who counts as "split with", adding, removing and leaving (pointer to ADR 0016)
16. [In-app notices](concepts/in-app-notices.md): the "added you to a bill" card, the New / Nothing claimed yet markers, Home's settle pills ("You owe", "Paid", "Settled up") with their batched read and truncation guard, why there are no read receipts, the Sent via Venmo pills (`sent` only while someone owes, `not_received`, `waiting_on_others`) with "seen" checked per version, and the delete-group popup (the one exception to inline confirms) and its one-time Home line
17. [Platform-specific files](concepts/platform-specific-files.md): `.native.ts` vs `.ts`, and keeping native modules (contacts, SMS) out of the web bundle
18. [Local notifications](concepts/local-notifications.md): the "Did your $15.10 to Hana go through?" check-in; local vs push, the push entitlement stripped for the free Apple account (and why the plugin order looks backwards), asking permission once and reading `ios.status`, record → schedule → open, cancel **and** dismiss on return, one undo rule, cold start and the resume gate, and why no server (ADR 0024)
19. [Design system](concepts/design-system.md): tokens in `lib/theme.ts`, primitives in `components/ui/`, "fix the system, not the screen", no glyphs (words + tone), per-icon lucide imports, contrast checked by a test, dark-mode backgrounds, the keyboard-only focus ring, the "native slop" review checklist, and Home on a phone (the sticky "Scan receipt" bar, the groups Waiting on you / Owed to you / Settled / hidden worked out from your balance rather than the pill, "Your share" / "To collect" / "Total", the first-load wait, and the `DisclosureRow` toggle), and the tab bar (badges, the light-orange dispute tokens, tinted `ListRow`s that dim when pressed)
20. [Mobile web](concepts/mobile-web.md): making the web app feel like an app in a phone browser: `theme-color` per colour scheme, `viewport-fit=cover` and safe-area insets, why inputs must be 16px on web, the manifest's `display: browser`, placeholder home-screen icons
21. [Group balances](concepts/group-balances.md): one net per person (paid − share + sent − received, always summing to $0), why a receipt counts only once fully claimed, greedy suggested payments with ties broken by user id (and why they can route money between people who never shared a cost), hiding 1¢ leftovers (`GROUP_IGNORE_CENTS`), largest-remainder Equal splits, a worked trip example, changing the payer of a group bill (ADR 0022), "needs you" / "I wasn't part of this" with Home's five group states, and why deleting a group checks waiting receipts before balances (`canDeleteGroup`). Read after [Money and rounding](concepts/money-and-rounding.md)
22. [Who pays whom](concepts/who-pays-whom.md): several payers on one bill (ADR 0023). A payments ledger that never erases a payment, each person's position (paid + sent − received − share), the fewest-payments greedy, plan keys that keep routes still when someone pays, money a former payer passes on, rule W (paid amounts add up exactly), and % → cents by largest remainder. Worked examples T0 (the user's), T1, T6, T7. Read after [Group balances](concepts/group-balances.md)
23. [Activity feed and badges](concepts/activity-feed-and-badges.md): the Activity tab and the tab-bar badges (ADR 0025). The feed built on the phone from reads RLS already allows, one rule function (`classifyFeedEvent`), keyset paging over two tables at microsecond precision, why a full page means "maybe more", roll-ups, the one "seen" rule (bill opens, group opens and the Activity tab, stored on the device), the Tabs / Groups / Activity badge rules, privacy as a display rule rather than a security boundary, and markers coloured only while unread. Read after [Audit log](concepts/audit-log.md) and [In-app notices](concepts/in-app-notices.md)
24. [LLM structured extraction](concepts/llm-structured-extraction.md) (**shelved fallback**): parsing receipts with Claude, only if our parser stays under 85% accuracy
25. [Fetching untrusted URLs (SSRF)](concepts/ssrf-and-untrusted-urls.md) (**deferred**): importing receipt links safely, if we ever add a server

## How notes are written
Every concept note has the same sections:
- **The idea:** a plain-language explanation
- **Why it matters here:** the concrete SplitIt problem it solves
- **How we use it:** pointers to our code once it exists, as the file plus the symbol name (`lib/split.ts`, `computeShares`), not line numbers, which move with every edit
- **Pitfalls:** the mistakes people actually make
- **Check yourself:** 2–4 questions to test your understanding
- **Learn more:** official docs

Decisions are written as ADRs (Architecture Decision Records); see [decisions/README.md](decisions/README.md).

Rules for adding notes:
- Add a note when a task introduces a concept someone new to the codebase wouldn't know, or makes a decision that's hard to reverse.
- Update an existing note rather than creating a near-duplicate.
- Once code exists, link to the real code. Keep examples small and correct.
