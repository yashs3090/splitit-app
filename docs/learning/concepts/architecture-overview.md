# Architecture overview

> **Updated 2026-11-20.** Receipts are now read on the device instead of by Claude in an Edge Function ([ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md)), and the app and its Supabase config live in one repo ([ADR 0011](../decisions/0011-single-repo.md)).
>
> **Updated 2026-11-21.** M1a built the parser and the bill form, and chose the recognition libraries, including Tesseract.js on web ([ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md)).

## The idea
SplitIt has two parts: a **client** (the Expo app on phones and the web) and a **managed backend** (Supabase). There is no server code of our own.

```
 ┌──────────────── Expo app (iOS / Android / web) ────────────────┐
 │  camera → on-device text recognition → lib/receiptText.ts       │
 │  (Vision / ML Kit; web: Tesseract.js)     (our parser) → form   │
 │  bill review     claim screen     settle                        │
 └──────┬──────────────┬────────────────┬──────────────┬───────────┘
        │ Auth         │ SQL over HTTPS  │ WebSocket    │ HTTPS
        ▼              ▼   (+ RLS)       ▼ (Realtime)   ▼
 ┌──────────────── Supabase (managed, we only configure it) ──────┐
 │  Auth (Google sign-in) → JWT with user id                       │
 │  Postgres: bills, line_items, claims, …  (RLS on every table)   │
 │  Storage: private receipt images (signed URLs)                  │
 │  Realtime: broadcasts row changes to subscribed clients         │
 │  Edge Functions: available, none used right now                 │
 └─────────────────────────────────────────────────────────────────┘
        Settle: app opens venmo.com / paypal.me / cash.app links
```

### Managed backend vs. custom backend
People say "no backend" loosely, so be precise:
- A **managed backend** is a service someone else runs for you. Supabase runs the servers for Auth, Postgres, Storage and Realtime. We only **configure** it: `supabase/config.toml`, SQL migrations, RLS policies. We still have a backend; we just don't operate or program it.
- A **custom backend** is code *we* write that runs on a server: an Edge Function, a Node API, a cron job. That's what SplitIt dropped. Supabase still offers Edge Functions; we don't use any right now.

[ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md) ("What 'no custom backend' means") explains the choice. If a feature seems to need server code, that's a decision for the user, not something to add quietly.

## Why it matters here
Each box has one job, and **trust boundaries** are explicit:
- The **client is untrusted.** Anyone can decompile an app or call our API directly with the public anon key. So the client never holds secrets, and every permission check happens in the database (RLS plus explicit grants).
- **Postgres is the source of truth.** Totals shown on screen come from rows in the database, recomputed with the same tested split function.
- **Secrets belong to Supabase, not the app.** The Google OAuth client secret lives in Supabase's config (`supabase/.env` locally, the dashboard when hosted), because Supabase Auth is what uses it. See [environment variables and secrets](env-vars-and-secrets.md).
- **Reading the receipt happens on the phone**, so there is no API key to protect and no per-scan cost. See [on-device OCR](on-device-ocr.md).

## How we use it
### Where the code lives (one repo)
- `app/`: Expo Router screens. `lib/`: pure logic with tests next to it. `components/`: shared UI.
- `supabase/`: `config.toml`, `migrations/`, `tests/database/` (pgTAP). Run Supabase CLI commands from the repo root with Docker running: `npx supabase start`, `npx supabase status`, `npx supabase db reset`, `npx supabase test db`.

### How a bill flows (end to end)
1. **Scan:** the host takes a photo. Apple Vision (iOS) or ML Kit (Android) reads the text on the phone. On web, Tesseract.js reads it in the browser (provisional), or the host types the items. The photo isn't uploaded. See [ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md).
2. **Parse:** `lib/receiptText.ts` turns the text into line items, subtotal, tax and tip, in integer cents, and runs the totals check (±1¢).
3. **Review and save:** the host fixes anything wrong in the bill form (`components/BillForm.tsx`), then taps "Save and share". That calls one database function, `create_bill`. It saves the bill, one row per unit, the host as a participant and a random 20-character `join_code`, all in one transaction ([ADR 0013](../decisions/0013-writes-through-database-functions.md), [database functions](database-functions.md)).
4. **Join and claim:** a friend opens the invite link (`/b/<code>`; dev-only URLs for now), signs in with Google, and `join_bill` adds them as a participant. They tap items, which inserts `claims` rows. A database trigger sends a data-free "changed" hint on the bill's private Realtime channel, and every phone re-reads the bill ([realtime](realtime.md)). Each change is also logged in the Activity timeline ([audit log](audit-log.md)).
5. **Shares:** each person's share is computed on the phone with `lib/split.ts`, with tax and tip split proportionally or equally ([ADR 0014](../decisions/0014-extras-split-proportional-or-equal.md)). **Settle** (payment links, marking paid) is M3 and not built yet.

### Shelved and deferred
- **Claude parsing** is a shelved fallback, only if parser accuracy stays under 85%. It would bring back an Edge Function and a per-scan cost. See [LLM structured extraction](llm-structured-extraction.md).
- **Receipt-link import** is deferred, because fetching third-party pages safely needs a server. See [SSRF](ssrf-and-untrusted-urls.md).

## Pitfalls
- Putting business rules only in the UI (e.g. "only the host can edit"). The UI is just a convenience; the database must enforce the rule.
- Computing money in two different places with two different implementations. One function, used everywhere.
- Thinking "no custom backend" means "no security work". RLS and grants *are* our server-side checks, so they need tests.
- Importing anything from `supabase/` into app code. The app talks to Supabase only over its public API.

## Check yourself
1. SplitIt "has no backend" and also "uses Supabase as its backend". How are both true?
2. If someone calls Supabase with the anon key and tries to read every bill, what stops them?
3. Why does the Google OAuth client secret live in Supabase's config rather than in the app?
4. Which change would force us to write custom server code again?

## Learn more
- https://supabase.com/docs/guides/getting-started/architecture
- https://supabase.com/docs/guides/local-development
