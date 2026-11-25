# SplitIt: plan for splitting a bill by item

> ## Amendment (2026-11-20)
> This plan is kept as written on 2026-11-19. Three things have changed since; where they conflict with the text below, these win.
> 1. **Receipt parsing:** [ADR 0010](../learning/decisions/0010-on-device-ocr-no-custom-backend.md) replaced Claude parsing in an Edge Function with **on-device text recognition** (Apple Vision on iOS, ML Kit on Android, manual entry on web) plus our own parser, `lib/receiptText.ts`. There is no custom server code, no Anthropic key and no per-scan cost. Claude is a shelved fallback if parser accuracy stays under 85% after tuning (the user's decision). So Phase 4's "AI parsing" bullet, the Edge Function flow in step 1, `parse-receipt/index.ts` and the Anthropic-key and token-cost notes are out of date.
> 2. **Link import is deferred** (ADR 0010). Fetching third-party receipt pages safely needs a server. Step 2 of the flow and M4 are on hold.
> 3. **One repo:** the user deleted `splitit-backend`. Its Supabase files now live in `splitit-app/supabase/` (`config.toml`, `migrations/`, `tests/database/`), and Supabase CLI commands run from the `splitit-app` root ([ADR 0011](../learning/decisions/0011-single-repo.md)). Read `../splitit-backend/...` paths below as `supabase/...`; the eval script idea now lives in the `/receipt-eval` skill.

## Context
The repo (`splitit-app`) is empty apart from a README. We're building an app where someone uploads a photo of a receipt, or pastes a link to a digital receipt, and the people at the table each claim what they ordered. The app then works out each person's share, including tax and tip, and links them to a payment app to settle up.

Decisions the user made: **React Native + Expo** (iOS, Android and web from one codebase); **every participant signs up**; settling up means **showing amounts and opening Venmo/PayPal/Cash App with the amount filled in**, with no money handled in-app.

Repos: `splitit-app` (Expo app, agents, docs) and `../splitit-backend` (Supabase: migrations, Edge Functions, eval scripts).

---

## Phase 0: Framing (PM)
- **For:** friends, roommates and coworkers who eat out together and split itemized bills.
- **Problem:** the person who paid has to type in or eyeball everyone's share. Splitting evenly feels unfair when orders differ.
- **Solution:** take a photo or paste a link, AI reads the line items, everyone claims their own items on their phone, and the app calculates exact shares with tax and tip and opens the payment app.
- **Assumptions:** AI can read most US restaurant receipts accurately (over 90% of line items correct), and friends will sign up when sent a link.

## Phase 1: Research (verified facts are linked; everything else is labeled)
| Product | What it does | Price | Notes |
|---|---|---|---|
| Splitwise **Itemize** | Photo → itemized bill. Friends claim items, including shared ones, and **join by QR code with no app or account**. Tax and tip are split proportionally | Free, US/UK | Nearly the same as our idea ([The Paypers](https://thepaypers.com/payments/news/splitwise-launches-itemize-receipt-splitting-feature-in-the-us-and-uk)) |
| Splitwise Pro | Receipt scanning and itemizing; the free tier has a daily entry cap and ads | ~$3.99–4.99/mo (unverified) | [App Store](https://apps.apple.com/us/app/splitwise/id458023433), [Finny](https://getfinny.app/blog/best-splitwise-alternatives-2026) |
| Venmo "Scan receipt" | Itemizes a scanned receipt and splits tax and tip, but the **host assigns** items. Launched 2026-11-09 | Free (unverified) | [PayPal newsroom](https://newsroom.paypal-corp.com/2026-11-09-Venmo-Launches-Receipt-Scanning-Feature-to-Split-Bills-by-Item) |
| Settle Up / Tricount / Splid / Spliit | Running group ledgers with no item scanning | Free or about $19/yr | [Finny](https://getfinny.app/blog/best-splitwise-alternatives-2026) |
| Indie AI splitters (SplitSnap, Tabify, Splitceipt, …) | Scan → assign | Mostly freemium | Crowded field; claims unverified |
| Do nothing | Split evenly, or one person does the math | Free | The most common real-world option |

**What this means for us:** scanning and splitting by item is now a free, built-in feature in the two biggest incumbents (Splitwise and Venmo). Few products clearly handle **receipt links** (Toast/Square/online-order emails) or merge **multiple receipts per outing**. Our requirement that everyone signs up is *more* friction than Splitwise Itemize. Differentiation has to come from speed, link import and UX, not from scanning itself.

## Phase 2: Personas (summary)
- **Priya, 21, student:** the group-dinner organizer who pays the bill and chases six friends for money. Delighted if claiming takes under 30 seconds. Drops off if friends ignore a sign-up wall. Won't pay.
- **Marcus, 34, consultant:** splits team lunches and wants receipts for expense reports. Might pay for exports and history. Churns if the OCR makes him fix lines by hand.
- **Dana, 29, privacy-skeptic:** "Why does a bill app need my account and photos of my receipts?" Needs clear data deletion, and a sign-in that doesn't ask for a password.

## Phase 3: PM critical questions
- **Real problem?** Yes and frequent, but incumbents now solve it for free. **The riskiest assumption is that people pick us over Splitwise Itemize or Venmo.**
- **MVP tests:** time from upload to all items claimed, and how many invitees actually sign up and claim.
- **Out of v1:** in-app payments, running balances, multi-currency, expense-report exports, merging multiple receipts.
- **Money:** free MVP. A possible future Pro tier (history, exports, unlimited scans). Unit cost per scan is about $0.05 with Opus 5.5 or about $0.002 with Haiku 5.5 (estimate, see Phase 4).
- **Metrics:** at least 60% of invitees claim at least one item; median time to fully claimed under 3 minutes; at least 30% of hosts create a second bill within 30 days.
- **Kill criteria:** under 40% of invitees complete sign-up and claim, or AI accuracy under 85% of line items after prompt tuning.
- **Top open questions:** (1) Does required sign-up kill participation? (2) How do we differentiate from Splitwise Itemize? (3) Which receipt-link formats matter most? (4) Is AI accuracy good enough on crumpled or long receipts? (5) Are people willing to pay at all?

## Phase 4: Engineer
**Recommended architecture:** Expo app + **Supabase** (Postgres, Auth, Storage, Realtime, Edge Functions). Edge Functions call the Claude API.
- Alternatives considered: Firebase (weaker relational data and SQL), or a custom Node backend on Fly or Render (more operations work). Supabase is the fastest path for a solo developer, and Realtime powers the live claiming screen.

**Stack**
- **App:** Expo SDK + Expo Router in TypeScript, using the camera and image picker (`expo-camera`, `expo-image-picker`). Deep links and universal links (`splitit.app/b/<code>`) let an invite survive the sign-up flow.
- **Auth:** Supabase Auth with Sign in with Apple, Google and email magic link. No passwords, which keeps the required sign-up as light as possible.
- **AI parsing:** Anthropic TypeScript SDK (`@anthropic-ai/sdk`) in a Supabase Edge Function (Deno).
  - Model: `claude-opus-5-5`, effort `low`, with structured outputs (`output_config.format`, JSON schema) and `fallbacks: "default"`.
  - Try `claude-haiku-5-5` against an eval set of real receipts. Switching models is the user's call.
- **Hosting:** Supabase cloud for the backend; EAS Build for the mobile apps; Expo web export on Vercel or Netlify.

**Pipelines**
1. **Photo:** compress on the client (~1600px), strip EXIF data, upload to private Storage. The Edge Function sends the image to Claude, which returns `{merchant, date, currency, items[{name, qty, unit_price_cents, total_cents}], subtotal, tax, tip, service_charge, discounts, total}`.
2. **Link:** the Edge Function fetches the URL with SSRF protections: https only, private and loopback IPs blocked, 5s timeout, 2MB cap, limited redirects. It extracts text, or passes a PDF through as a document, and sends it to Claude with the same schema.
   - Many receipt pages render with JavaScript. A spike decides between the Claude `web_fetch` tool, a headless-render service, or falling back to "take a screenshot".
3. **Validation:** check that the line items add up to the subtotal and that subtotal + tax + tip = total (±1¢). If not, flag the bill for host review. The host can always edit, add or delete lines before sharing.
4. **Claiming:** the host shares a link or QR code. Each participant signs in, joins, and taps items. Items with qty > 1 can be claimed per unit. Shared items are split evenly among the people who claim them, or by custom shares. Supabase Realtime shows live claim state and unclaimed items.
5. **Settle:**
   - All math in integer cents. Tax, tip and fees are allocated in proportion to each person's subtotal, using largest-remainder rounding so the shares add up to the total exactly.
   - Payment links:
     - Venmo: `https://venmo.com/?txn=pay&recipients=<host>&amount=<x>&note=<bill>` ([Venmo docs](https://venmo.com/paymentlinks))
     - PayPal: `paypal.me/<handle>/<amount>`
     - Cash App: `cash.app/$<tag>/<amount>`
   - Participants mark "paid" themselves; the host confirms.

**Data model**
- `profiles` (id, display_name, venmo/paypal/cashapp handles)
- `bills` (id, host_id, title, source_type photo|link, source_url, image_path, status draft|open|settled, currency, subtotal/tax/tip/fees/total cents, join_code)
- `bill_participants` (bill_id, user_id, paid_at)
- `line_items` (id, bill_id, name, qty, unit_cents, total_cents, position)
- `claims` (line_item_id, user_id, units or share_weight)
- `parse_runs` (bill_id, model, raw_json, valid, cost_tokens), kept for debugging and evals

**Security and privacy**
- Row Level Security: only participants can read a bill; only the host edits its lines; users write only their own claims.
- Receipt images are stored privately and accessed through signed URLs; images are automatically deleted after 30 days.
- Users can delete their account.
- The Anthropic key lives only in Edge Function secrets.
- Rate limits on parse calls per user.
- Join codes are random and unguessable (≥10 chars) and can be revoked.

**Hard problems and spikes (do first)**
1. AI accuracy on about 30 real receipts (crumpled, long, modifiers like "+ avocado", discounts, multiple languages). Build a small eval script.
2. Parsing receipt links: Toast, Square, DoorDash/Uber Eats emails and PDFs.
3. Keeping the invite link through the sign-up flow, from cold start, on iOS, Android and web.

**Costs (estimates)**
- Claude per receipt: about 2.5k input tokens and about 1.5k output.
  - Opus 5.5 ($4/$20 per MTok) ≈ $0.04 per receipt.
  - Haiku 5.5 ($0.10/$0.50) ≈ $0.001 per receipt.
- Supabase: free tier, then $25/mo Pro.
- Apple Developer program: $99/yr.

**Milestones**
- **M0 (S):** Expo + Supabase scaffold, auth, deep links.
- **M1 (M):** photo upload → AI parse → editable bill.
- **M2 (M):** share link, join, live claiming, split math with unit tests.
- **Profile + Venmo (S, before M3; user decision 2026-11-24):** a Profile screen (name, editable Venmo username, sign out; bill history later). Optional, skippable "Add your Venmo" prompt at first sign-in.
- **M3 (S):** settle screen with payment deep links, paid status. User decisions 2026-11-24: **Venmo only for now** (PayPal/Cash App later). **The host chooses who gets paid:** it defaults to the host, and once others have joined the host can set any participant as the payer. Everyone else pays the payer, and the payer owes nothing. Each person who owes marks "I paid" themselves (self-reported; the app can't check Venmo), and the host can undo a wrong mark.
- **People you've split with (M, after M3; user decision 2026-11-24):** a list of people you've shared bills with, worked out from past bills (no friend requests). It's searchable, with the people you've split the most bills with at the top. The host can add someone from that list straight onto a bill, even if they haven't opened its link; the bill then shows in their "Your bills" list and they claim as usual. You can only add people you've already shared a bill with, enforced in the database. Adding people who aren't on the app by name (placeholders) and real friend requests are deferred.
- **Invite from contacts (S, after People; user decision 2026-11-24):** pick a phone contact and open a text or WhatsApp message with the bill link filled in. Contacts stay on the device (no contact sync or upload).
- **M4 (M):** link import.
- **v1 (L):** history, push notifications, reminders.
- **v2:** multiple receipts per outing, running balances, exports, Pro tier.

## Phase 5: Roundtable and synthesis
- **User → Engineer:** "Signing up just to tap my burger? Splitwise lets me scan a QR code." The PM keeps required accounts, as the user decided, but insists on one-tap Apple/Google sign-in and on keeping the invite through sign-up. **Open question:** allow guest claiming that converts to an account later.
- **PM → Engineer:** cut link import from the MVP unless the spike shows it's cheap. Photo is the core flow.
- **Engineer → PM:** split math and rounding are where trust is won or lost. Unit-test them heavily before polishing the UI.

**Recommended MVP:** sign in with Apple/Google, take a photo of a receipt, AI parses it, the host reviews and edits, the host shares a link or QR, friends sign in and claim items live, exact shares with tax and tip, then open Venmo, PayPal or Cash App.

**Next validation steps:**
- Collect 30 real receipts and run the accuracy eval on Opus 5.5 and Haiku 5.5.
- Test with 3 friend groups at real dinners, measuring sign-up drop-off.
- Try Splitwise Itemize and Venmo scan side by side and list the UX gaps.

**Risks to watch:** incumbents shipping the same feature for free; sign-up friction; AI misreads damaging trust; receipt-link pages that need JavaScript to render; App Store review of the payment deep links (low risk).

---

## Self-learning agent team (set up before M0)
**Goal:** a repeatable loop where agents plan, build, review and test each piece of work, and every round's lessons are fed back into the agents and skills. That way mistakes don't repeat and repeated workflows get turned into skills.

**Agents** (`.claude/agents/*.md`, each with frontmatter for name, description, tools and model):
| Agent | Role | Tools |
|---|---|---|
| `product-manager` | Breaks a milestone into small tasks with acceptance criteria; cuts scope; challenges assumptions (same voice as the app-planner PM) | Read-only + write under `docs/` |
| `implementer` | Builds one task, writing tests first; follows `CLAUDE.md` + relevant lessons | All |
| `code-reviewer` | Read-only review for correctness, RLS/security, split-math correctness, and project conventions; returns findings ranked by severity | Read, Grep, Bash (tests only) |
| `qa-tester` | Runs tests and the app (Expo web / simulator), checks each acceptance criterion, reports pass/fail with evidence | Bash, Read, browser tools |
| `retro` | Reads the round's outcome (review findings, QA failures, user corrections) and proposes updates to lessons, skills and agents | Read + write under `docs/lessons/`, `.claude/` |

**Skills** (`.claude/skills/<name>/SKILL.md`):
- `build-task`: the orchestrator loop:
  1. PM spec.
  2. Implementer.
  3. Reviewer. If there are blocking findings, the implementer fixes them and the reviewer reviews again (max 3 rounds).
  4. QA.
  5. Retro.
  6. Summary to the user.
- `retro`: the learning step (rules below). Can be run by hand as `/retro`.
- `receipt-eval`: runs `scripts/eval-receipts.ts` and compares accuracy across models and prompts.
- Grown over time: e.g. `supabase-migration`, `expo-screen`, `split-math-rules`, created by `retro` once a pattern has repeated.

**How the learning loop works**
1. Every round's findings are added as dated entries to `docs/lessons/log.md` (what went wrong, why it happened, the fix).
2. **Promotion rules:**
   - A mistake that shows up twice becomes a rule in the relevant agent file, or in `CLAUDE.md`.
   - A multi-step workflow repeated twice becomes a new skill, written with the `skill-creator` skill.
   - Rules that turn out wrong are deleted.
3. **You approve every change:** `retro` writes diffs to `.claude/` and `CLAUDE.md`, and you approve them, so the agents don't drift on their own.
4. Agents read `CLAUDE.md` plus the matching sections of `docs/lessons/` at the start of each task.
5. Optional: a `Stop` hook, set up via the `update-config` skill, that reminds you to run `/retro` after a `build-task` run. Not auto-run, to keep costs down.

**Files:**
- `CLAUDE.md`: project overview, stack, conventions, pointers to lessons and agents.
- `.claude/agents/{product-manager,implementer,code-reviewer,qa-tester,retro}.md`
- `.claude/skills/{build-task,retro,receipt-eval}/SKILL.md`
- `docs/lessons/log.md`

**Check:** run `build-task` on M0. The PM spec, implementer, reviewer findings, QA report and retro entry should all be produced, and the retro should propose at least one concrete update for you to approve.

## Critical files to create (implementation, after approval)
- `docs/plans/bill-splitting-app-2026-11-19.md`: full planning doc
- `app/` (Expo Router screens): `(auth)/`, `bills/new.tsx`, `bills/[id]/review.tsx`, `b/[code].tsx` (join/claim), `bills/[id]/settle.tsx`
- `lib/split.ts`: pure split and rounding logic, plus `lib/split.test.ts`
- `lib/paylinks.ts`: Venmo/PayPal/Cash App URL builders
- `../splitit-backend/supabase/migrations/0001_init.sql`: schema + RLS
- `../splitit-backend/supabase/functions/parse-receipt/index.ts`: Claude call with structured output and validation
- `../splitit-backend/scripts/eval-receipts.ts`: accuracy eval over a folder of sample receipts

## Verification
- `npm test`: unit tests for `split.ts`, covering shared items, qty splits, rounding that adds up to the total, and zero tip.
- `supabase start` + `supabase db reset`: migrations apply; RLS tests confirm a non-participant can't read a bill.
- `supabase functions serve parse-receipt` + curl with a sample image returns schema-valid JSON whose totals reconcile.
- `npx expo start` on the iOS simulator and the web: full flow with 2 test accounts (create → share → claim → settle), checking that the Venmo link opens with the right amount.
- Run `scripts/eval-receipts.ts` on the sample set and report line-item accuracy.
