# 0011: One repo for the app and the Supabase config

**Status:** Accepted (2026-11-20). Supersedes [0003](0003-two-repos.md).

## Context
[0003](0003-two-repos.md) split SplitIt into `splitit-app` (the Expo app) and `splitit-backend` (Supabase migrations, Edge Functions, eval scripts). The split made sense when the backend was going to hold real server code: the `parse-receipt` Edge Function that called Claude with a secret API key.

Then [0010](0010-on-device-ocr-no-custom-backend.md) dropped all custom server code. Receipts are read on the phone, and the app writes `line_items` itself, protected by RLS. After that, the second repo held only Supabase **config and SQL**: `config.toml`, migrations, and database tests. On 2026-11-20 the user deleted the `splitit-backend` repo.

With two repos, most features meant two coordinated changes. A new table, its RLS policies and the screen that reads it lived in different places, could be reviewed separately, and could drift apart.

## Options
| Option | Pros | Cons |
|---|---|---|
| Keep two repos (0003) | Clear boundary; backend could deploy on its own | Two changes per feature; types and migrations drift; a whole repo for a handful of config and SQL files |
| **One repo, Supabase config in `supabase/`** | One change (and one review) per feature; migrations sit next to the code that uses them; one place to clone and run | No hard wall between app code and backend files, so we rely on rules (below) to keep secrets out of the bundle |
| A monorepo with workspaces (`apps/`, `packages/`) | Room for shared packages later | Extra tooling we don't need for one app plus config |

## Decision
Everything lives in `splitit-app`. Supabase's files are in `supabase/` at the repo root:
- `supabase/config.toml`: local Supabase settings (auth providers, redirect URLs).
- `supabase/migrations/`: SQL migrations (tables, RLS policies, grants).
- `supabase/tests/database/`: pgTAP tests for RLS and constraints.
- `supabase/.env.example`: names of the Google OAuth values. The real `supabase/.env` is gitignored.

Supabase CLI commands run from the **repo root**, with Docker running: `npx supabase start`, `npx supabase status`, `npx supabase db reset`, `npx supabase test db`. The local stack generates its own keys and database password, so for local development the user supplies only the Google OAuth client ID and secret (see [Google OAuth setup](../../setup/google-oauth.md)).

## Consequences
- **One change per feature.** A migration, its pgTAP test and the screen that uses it land together and get reviewed together.
- **Generated types stay simple.** `npx supabase gen types typescript --local` can write straight into the app (e.g. `lib/database.types.ts`, not built yet), with no copying between repos.
- **Secrets still stay out of the app**, but now by rule rather than by repo boundary. The app only reads `EXPO_PUBLIC_*` values, `lib/env.ts` refuses secret keys, and the web build leak check (`grep -rE "service_role|sb_secret_" dist/`) must print nothing. Nothing under `supabase/` is imported by app code.
- Older docs (the plan, the M0 spec, ADR 0003) still mention `../splitit-backend`. They are history and carry dated notes pointing here.

**Revisit when:** we write substantial server code again (for example the Claude fallback in an Edge Function, or receipt-link import), or a separate person or team owns the backend and needs its own release cycle.

## Concept: repo boundaries follow ownership and deploys
Split code into separate repos when the parts are **owned by different people** or **deployed on different schedules**. Splitting along a technical line ("frontend" vs. "backend") alone isn't enough, because every feature then crosses the boundary. SplitIt has one owner and no server program to deploy, so one repo is simpler. Supabase's own CLI is built for this layout: `supabase init` creates a `supabase/` folder inside your app's project.
