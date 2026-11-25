# Proposal: CLAUDE.md gets the agent `.env` rule and the before-production checklist

**Status:** applied 2026-11-21 (Change 1's "old" Secrets line had already been updated to `supabase/.env`; the new bullet was inserted after the current line, which was left as is)
**Target file:** `CLAUDE.md` § Conventions and § How we work
**Promotion rules used:**
- Same lesson seen twice: agents touching `.env` files was blocked in M0 (writing a dummy `.env`) and again in M1a (a Bash grep that counted matches in `.env` files). The rule lives in some agent files but not in `CLAUDE.md`, which every agent reads.
- User instruction (M1a): keep `docs/before-production.md` up to date.

Independent of the pending `2026-11-21-claude-md-commands.md` and `2026-11-19-rls-explicit-grants.md` proposals; the edits don't overlap.

## Change 1: § Conventions, new bullet after the "Secrets ..." bullet

Old:
```
- Secrets (service-role key, Google OAuth client secret, any future API key) never go in the app bundle or in `EXPO_PUBLIC_*` vars. The Google OAuth values live in `../splitit-backend/supabase/.env` (read by `config.toml`).
```

New:
```
- Secrets (service-role key, Google OAuth client secret, any future API key) never go in the app bundle or in `EXPO_PUBLIC_*` vars. The Google OAuth values live in `../splitit-backend/supabase/.env` (read by `config.toml`).
- Agents never read, grep, count, create or edit `.env*` files (only `.env.example`), for any reason. Pass needed values inline on the command line, use what tools report (`npx expo-doctor`, `npx supabase status`), or ask the user. The root `.env` holds only `EXPO_PUBLIC_*` values.
```

(The `../splitit-backend/` path in the line above is stale after ADR 0011; the pending Commands proposal lists it under "Not proposed". It's left alone here so the two proposals don't conflict.)

## Change 2: § How we work, new bullet at the end

Old:
```
- Keep `docs/learning/` current: when a task introduces a concept or a hard-to-reverse decision, add or update a concept note or an ADR (see `docs/learning/README.md`). The user studies these.
```

New:
```
- Keep `docs/learning/` current: when a task introduces a concept or a hard-to-reverse decision, add or update a concept note or an ADR (see `docs/learning/README.md`). The user studies these.
- Keep `docs/before-production.md` current: any "for now", provisional or dev-only decision, and any production-only risk found in review or QA, gets an item there in the same task.
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: Agents don't write .env or break code on disk; use inline env vars [area: testing]"
- "2026-11-21: Agents tried to read `.env` again; the permission system blocked it [area: testing]"
- "2026-11-21: Root `.env` carries Google OAuth variables [area: expo]"
- "2026-11-21: Keep `docs/before-production.md` current [area: process]"
