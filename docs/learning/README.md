# Learning notes

Study material for the important ideas behind SplitIt: why we chose what we chose, how the system fits together, and the engineering concepts a junior engineer should understand to work on it. These notes are added to as the app is built (step 5 of the `build-task` skill).

**Start here:** [Important catches and caveats](catches.md): one page of the things that are easy to get wrong, with links to the full notes.

## Suggested reading order
1. [Architecture overview](concepts/architecture-overview.md): the big picture, including managed vs. custom backend
2. [Design decisions](decisions/README.md): why each major choice was made (ADRs)
3. [Database design](concepts/database-design.md): tables, keys, relationships, migrations
4. [Row Level Security](concepts/row-level-security.md): authorization inside the database
5. [Database functions](concepts/database-functions.md): security definer vs invoker, why our write paths are SQL functions, row locks (`for update` vs `for share`), and one lock order per bill (the deadlock review R1 fixed)
6. [Money and rounding](concepts/money-and-rounding.md): integer cents, largest-remainder allocation, unit rows, proportional vs equal extras, who owes the payer when settling up, and discounts people claim like items (negative shares)
7. [Auth and deep links](concepts/auth-and-deep-links.md): sign-in, sessions, invite links, how Google and Supabase fit together, the two redirect allow-lists, PKCE, and the "stuck on localhost" debugging story
8. [Environment variables and secrets](concepts/env-vars-and-secrets.md): what is public, what is secret, and build-time inlining
9. [On-device text recognition (OCR)](concepts/on-device-ocr.md): reading a receipt photo on the phone, why text isn't meaning, and the parser's rules for quantities, prices and totals
10. [The scan pipeline](concepts/scan-pipeline.md): locate → crop → size → enhance → read → check, one retry, "Retake photo / Type it in"; why geometry and scale beat filters, why never black-and-white, and how tuning vs held-out receipts decide what ships (ADRs 0018, 0019)
11. [Realtime](concepts/realtime.md): live claiming between phones with data-free broadcasts, and debouncing them into one refetch
12. [Stale-state checks](concepts/stale-state-checks.md): optimistic concurrency, or "send what you saw, and let the database refuse if it changed"
13. [Audit log](concepts/audit-log.md): the append-only Activity timeline
14. [Testing strategy](concepts/testing-strategy.md): what to test and how, including measuring a change on real receipts
15. [People and membership](concepts/people-and-membership.md): who counts as "split with", adding, removing and leaving (pointer to ADR 0016)
16. [In-app notices](concepts/in-app-notices.md): the "added you to a bill" card, the New / Nothing claimed yet markers, and why there are no read receipts
17. [Platform-specific files](concepts/platform-specific-files.md): `.native.ts` vs `.ts`, and keeping native modules (contacts, SMS) out of the web bundle
18. [LLM structured extraction](concepts/llm-structured-extraction.md) (**shelved fallback**): parsing receipts with Claude, only if our parser stays under 85% accuracy
19. [Fetching untrusted URLs (SSRF)](concepts/ssrf-and-untrusted-urls.md) (**deferred**): importing receipt links safely, if we ever add a server

## How notes are written
Every concept note has the same sections:
- **The idea:** a plain-language explanation
- **Why it matters here:** the concrete SplitIt problem it solves
- **How we use it:** pointers to our code (`file:line` once it exists)
- **Pitfalls:** the mistakes people actually make
- **Check yourself:** 2–4 questions to test your understanding
- **Learn more:** official docs

Decisions are written as ADRs (Architecture Decision Records); see [decisions/README.md](decisions/README.md).

Rules for adding notes:
- Add a note when a task introduces a concept someone new to the codebase wouldn't know, or makes a decision that's hard to reverse.
- Update an existing note rather than creating a near-duplicate.
- Once code exists, link to the real code. Keep examples small and correct.
