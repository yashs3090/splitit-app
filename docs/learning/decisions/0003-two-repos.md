# 0003: Separate app and backend repos

**Status:** Superseded by [0011](0011-single-repo.md) (2026-11-20). Previously Accepted (2026-11-19).

## Context
The user created `splitit-app` and `splitit-backend` as separate repositories.

## Decision
- `splitit-app`: the Expo client, plus the agent team, skills and docs.
- `splitit-backend`: Supabase migrations, Edge Functions, seed data, and eval scripts.

## Tradeoffs (vs. a monorepo)
- **Pro:** clear ownership boundary; the backend deploys on its own; the app never accidentally imports server code holding secrets.
- **Con:** shared types (e.g. the parsed-receipt shape, database row types) can drift between repos. Mitigation: generate TypeScript types from the database (`supabase gen types typescript`) and copy or publish them into the app. A future ADR can decide whether that's a script or a shared package.
- **Con:** a feature touching both repos needs two coordinated changes. Specs from the product-manager agent name the repo for each task.
