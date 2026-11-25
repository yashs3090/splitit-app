# Proposal: reword the RLS convention to require explicit grants

**Status:** applied 2026-11-21 (approved by the user)
**Target file:** `CLAUDE.md` § Conventions
**Promotion rule used:** "A rule that caused a wrong result gets a proposal to delete or reword it" (retro SKILL.md §2). The "seen twice" rule doesn't apply yet. The current convention reads as if "RLS enabled" makes a table secure. Following it produced a table whose security depended on Supabase's implicit default grants, and spec criterion 12 encoded that assumption ("0 rows"). Review had to correct it.

## Exact change

Old:
```
- Every table has RLS enabled. Only participants can read a bill; only the host edits line items; users write only their own claims.
```

New:
```
- Every table has RLS enabled **and** explicit grants: `revoke all on <table> from anon, authenticated, public`, then grant only the privileges each role needs (per column for UPDATE where possible). Never rely on Supabase's default grants on `public`. Denied operations should fail with `42501`, and acceptance criteria should expect that. Only participants can read a bill; only the host edits line items; users write only their own claims.
```

## Not proposed (and why)
- A matching line in `.claude/agents/code-reviewer.md`: the reviewer already caught this (R1) and reads CLAUDE.md. Add it only if a later review misses it (the second-occurrence rule).

## Evidence
- `docs/lessons/log.md`: "2026-11-19: RLS is not enough; revoke default grants and grant the minimum [area: rls]"
- R1 in review of `docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md`; criterion 12 update in that spec.
