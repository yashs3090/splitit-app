# Proposal: name columns on tables with column grants; pgTAP tests scope to fixture rows

**Status:** applied (2026-11-24, approved by the user)
**Target files:** `.claude/agents/supabase-engineer.md` § Rules, `.claude/agents/code-reviewer.md` § What to look for (2. Security and privacy), `.claude/agents/product-manager.md` § Rules
**Promotion rules used:**
- Changes 1, 3 (first sentence) and 4: the third RLS-area lesson. The column-grant rule from M1b+M2 had a side effect nobody wrote down, and a spec criterion got it wrong (criterion 34).
- Change 2 and the pgTAP sentence in Change 3: a pgTAP test that only passes on an empty database broke once the "don't `db:reset` without asking" rule (live-db-smoke) meant local data persists. This is a first occurrence, but it comes straight from an existing rule, so the fix belongs next to it. Reject those parts on their own if you'd rather wait for a second occurrence.

## Change 1: `.claude/agents/supabase-engineer.md`

Old:
```
- **Cross-user reads expose only the intended columns.** If other users should see one field (e.g. a co-participant's `display_name`), use column-level SELECT grants or a view/function that returns only those columns. A row-level policy alone exposes the whole row.
```

New:
```
- **Cross-user reads expose only the intended columns.** If other users should see one field (e.g. a co-participant's `display_name`), use column-level SELECT grants or a view/function that returns only those columns. A row-level policy alone exposes the whole row.
- **Column grants break `*`.** On a table where clients lack SELECT on some columns, anything that expands to `*` fails with `42501` for every caller, the owner included: `select('*')`, a bare `.select()` after insert/update/upsert (supabase-js sends `select=*`, so Postgres runs `RETURNING *`), and `returning *` in SQL. Name the columns. Add a comment in the migration listing which columns clients can't read.
```

## Change 2: `.claude/agents/supabase-engineer.md`

Old:
```
- Every migration gets pgTAP tests in `supabase/tests/database/` with `plan(N)` matching the assertion count.
```

New:
```
- Every migration gets pgTAP tests in `supabase/tests/database/` with `plan(N)` matching the assertion count.
- pgTAP assertions filter to the rows the test created (fixture ids or a unique tag), never whole-table counts or selects. The local DB may hold the user's real data, because we apply migrations with `migration up` rather than `db:reset`. A test that only passes on an empty DB is a bug.
```

## Change 3: `.claude/agents/code-reviewer.md`

Old:
```
For each table, ask which **columns** each role can read (not just which rows), who can write audit/event rows (including `service_role`), whether append-only guards hold no matter whose RLS applies, and whether any role/action has more than one permissive policy.
```

New:
```
For each table, ask which **columns** each role can read (not just which rows), who can write audit/event rows (including `service_role`), whether append-only guards hold no matter whose RLS applies, and whether any role/action has more than one permissive policy. On tables with column-level grants, flag any `select('*')` or bare `.select()` after a write (it fails with `42501`), and any pgTAP assertion that counts or selects a whole table instead of the fixture rows.
```

## Change 4: `.claude/agents/product-manager.md`

Old:
```
- Money math, privacy and RLS always get explicit acceptance criteria.
```

New:
```
- Money math, privacy and RLS always get explicit acceptance criteria. Client calls written into criteria name their columns (`.select('venmo_username')`, never a bare `.select()` or `select('*')`): on tables with column-level grants, `*` fails with `42501` for everyone.
```

## Evidence (docs/lessons/log.md)
- "2026-11-22: DB review: audit log could be forged, profiles over-shared, guards ran through the caller's RLS [area: rls]" (column-level grants introduced)
- "2026-11-24: With column-level grants, a bare `.select()` fails with 42501 [area: rls]"
- "2026-11-24: A pgTAP test counted all claims and failed on real local data [area: testing]"
