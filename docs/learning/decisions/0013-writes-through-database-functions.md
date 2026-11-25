# 0013: Writes go through security-definer database functions

**Status:** Accepted (2026-11-21, spec Amendment A1.4). Amends one line of [0010](0010-on-device-ocr-no-custom-backend.md).

## Context
[ADR 0010](0010-on-device-ocr-no-custom-backend.md) said: "The app writes `line_items` directly. RLS plus explicit grants make sure only the host can do that." When we built sharing and claiming (spec `docs/specs/2026-11-20-m1b-m2-share-and-claim.md`), four writes didn't fit that model:

1. **Saving a bill touches three tables at once.** The bill, its item rows and the host's participant row must all be saved, or none of them. If the app made three separate requests and the second failed, we'd have a bill with no items.
2. **Joining by code.** Someone who isn't in a bill yet can't read it (RLS), so they can't look up its id from the code. Letting everyone read `bills` would expose every bill.
3. **A host edit is a diff.** Rename some rows, reprice others, delete one and add one. All of that must happen together, or a participant could see half an edit.
4. **Setting someone else's split.** The user decided (A1.2) that any current claimer of an item can set everyone's parts on that item. A table grant can't say "you may update other people's `parts`, but only on rows where you have a claim yourself".

## Options
| Option | What it means | Problem |
|---|---|---|
| Direct table writes + RLS (0010's line) | The app calls `insert`/`update` on each table | Not atomic across tables. Can't express "join by code" or "a claimer sets others' parts" without opening up reads or writes too far. |
| A custom backend (Edge Function or Node server) | Our own server code checks and writes | Brings back a server we run and deploy, which 0010 rejected |
| **SQL functions in the database** | The app calls `supabase.rpc('create_bill', …)`; the function checks and writes inside one transaction | Logic lives in SQL, so it's tested with pgTAP rather than Jest |

## Decision
- **Writes that span tables, host-only writes and writes to other people's rows go through `security definer` SQL functions:** `create_bill`, `update_bill`, `join_bill`, `rotate_join_code`, `set_item_split` and `set_extras_split`.
- **Claiming or unclaiming yourself goes through `set_claim`, a `security invoker` function.** It runs as the caller, so RLS and the column grants still apply. Clients may also insert or delete their own claim directly.
- Clients have **no** insert, update or delete grant on `bills`, `line_items` or `bill_participants`, and **no update grant on `claims`**. The functions are the only way to make those changes.
- Every function sets `search_path = ''`, uses schema-qualified names, checks `auth.uid()` first, revokes `execute` from `public` and `anon`, and grants it to `authenticated` only.
- Errors are a fixed SQLSTATE plus a fixed short message (for example `22023 'claimers_changed'`). The app maps only those to its own copy (`lib/bills.ts:119-130`).
- The join code is generated in the database (80 random bits), never by the client.

This replaces 0010's sentence "The app writes `line_items` directly". The rest of 0010 still stands.

## Why this is still "no custom backend"
These functions are SQL that runs **inside the managed Supabase Postgres**. They're versioned in `supabase/migrations/` like the tables. No server program of ours runs anywhere, nothing needs deploying apart from migrations, and no secret is held. This is the same kind of thing as an RLS policy: rules we give the database, not a service we operate.

## Consequences
- Each function is a security boundary. Its guard list (who may call it, which rows it may touch) has to be reviewed and tested as carefully as an API endpoint. pgTAP tests: `supabase/tests/database/bill_functions.test.sql`, `bill_edit_realtime.test.sql`, `item_split.test.sql`, `bill_events.test.sql`, `extras_split.test.sql`.
- Business rules that live in SQL can't be unit-tested in Jest. Pure logic that doesn't need to be trusted (unit expansion in `lib/billPayload.ts`, split math in `lib/split.ts`) stays in the app. The database **re-validates** what it receives (`private.validate_bill_rows`).
- Activity events can be written in the same transaction as the change (see [audit log](../concepts/audit-log.md)).
- There's still no server-side rate limiting. See `docs/before-production.md` §4.

Code:
- `supabase/migrations/20261121074604_bill_functions.sql`: first versions of `create_bill`, `join_bill`, `rotate_join_code` and `set_claim`.
- `supabase/migrations/20261121074859_bill_discounts_split.sql`: `create_bill` re-created with two discount fields.
- `supabase/migrations/20261121075448_bill_edit_realtime.sql`: `update_bill`.
- `supabase/migrations/20261121075755_item_split.sql`: `set_item_split`.
- `supabase/migrations/20261121080352_bill_events.sql`: the current versions of the five writers, which now log Activity events.
- `supabase/migrations/20261121130144_extras_split.sql`: `set_extras_split`.

Concept note: [database functions](../concepts/database-functions.md).
