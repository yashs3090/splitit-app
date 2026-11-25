# Proposal: RLS rules for column exposure, audit tables, policy count and child-row races

**Status:** applied 2026-11-22
**Target files:** `.claude/agents/supabase-engineer.md` § Rules, `.claude/agents/code-reviewer.md` § What to look for
**Promotion rule used:** a second RLS-area lesson (M0's "RLS is not enough"; the M1b+M2 DB review), each showing that table-level "who can read this" was answered but a narrower question wasn't.

## Exact change

### Change 1: `supabase-engineer.md` § Rules, new bullets after "Every table"

Old:
```
- Functions: `security definer` only when needed, always `set search_path = ''`, fully qualified names, `revoke execute ... from public, anon, authenticated` unless a client must call it.
```

New:
```
- **Cross-user reads expose only the intended columns.** If other users should see one field (e.g. a co-participant's `display_name`), use column-level SELECT grants or a view/function that returns only those columns. A row-level policy alone exposes the whole row.
- **Audit / append-only tables** (e.g. bill activity events) are written only by triggers or `security definer` functions. Revoke INSERT/UPDATE/DELETE from every role that doesn't need it, **including `service_role`** where nothing legitimate uses it, so events can't be forged. Enforce append-only with a trigger that blocks UPDATE/DELETE regardless of the caller's RLS (allowing only the intended `on delete cascade` from the parent). Every state-changing function logs exactly one event with no duplicated fields, and pgTAP asserts that for each action (including merges and other indirect changes).
- **One permissive policy per role and action.** Combine conditions with `or` in one policy instead of stacking permissive policies (they're harder to reason about and slower; the Supabase advisor flags them).
- **Child-row inserts don't race the parent.** A function that checks a parent row and then inserts a child (e.g. `set_claim` on an item) locks the parent (`select ... for update`) or relies on the FK and maps `23503` to a clean, named error.
- Functions: `security definer` only when needed, always `set search_path = ''`, fully qualified names, `revoke execute ... from public, anon, authenticated` unless a client must call it.
```

### Change 2: `code-reviewer.md` § What to look for, item 2

Old:
```
2. **Security and privacy:** missing or too-broad RLS policies; secrets in client code; SSRF in URL fetching; guessable join codes; receipt images readable without permission.
```

New:
```
2. **Security and privacy:** missing or too-broad RLS policies; secrets in client code; SSRF in URL fetching; guessable join codes; receipt images readable without permission. For each table, ask which **columns** each role can read (not just which rows), who can write audit/event rows (including `service_role`), whether append-only guards hold no matter whose RLS applies, and whether any role/action has more than one permissive policy.
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: RLS is not enough; revoke default grants and grant the minimum [area: rls]"
- "2026-11-22: DB review: audit log could be forged, profiles over-shared, guards ran through the caller's RLS [area: rls]"
