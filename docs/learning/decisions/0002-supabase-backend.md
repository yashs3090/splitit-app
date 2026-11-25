# 0002: Supabase as the backend

**Status:** Accepted (2026-11-19)

> **Note (2026-11-20):** the choice of Supabase stands. The last sentence of the Decision (Edge Functions for calling Claude and fetching URLs) no longer describes the plan: [0010](0010-on-device-ocr-no-custom-backend.md) moved receipt reading onto the device, shelved Claude, deferred link import, and left us with no Edge Functions for now. Supabase's files now live in this repo's `supabase/` folder ([0011](0011-single-repo.md)).

## Context
We need a relational database (bills → line items → claims), user auth, private file storage for receipt photos, live updates while friends claim items, and somewhere to run server-only code (the AI call holding our API key). One developer.

## Options
| Option | Pros | Cons |
|---|---|---|
| **Supabase** | Postgres (real SQL, foreign keys, transactions); Auth; Storage; Realtime; Edge Functions; generous free tier | Authorization logic lives in SQL policies (RLS), which you have to learn |
| Firebase | Mature, great mobile SDKs | Firestore is a document DB: relationships and sums across bills/items/claims are awkward; vendor lock-in |
| Custom Node API + Postgres (Fly/Render) | Full control | We'd build auth, storage, realtime and deploys ourselves: weeks of work before any product |

## Decision
Supabase. The client talks to Postgres directly through Supabase's auto-generated API. **Row Level Security** (RLS) policies decide what each user can read or write. Anything secret or expensive (calling Claude, fetching URLs) runs in **Edge Functions**.

## Consequences
- Security depends on RLS being right on *every* table. A table without RLS is readable by anyone with the public anon key. See [row-level-security](../concepts/row-level-security.md).
- Schema changes go through versioned SQL migration files, never through clicking around in the dashboard. See [database-design](../concepts/database-design.md).
- If we outgrow it, it's still plain Postgres: data and SQL are portable.

## Learn more
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/functions
