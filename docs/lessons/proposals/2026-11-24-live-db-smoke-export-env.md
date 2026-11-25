# Proposal: live-db-smoke exports the keys with `set -a`

**Status:** applied (2026-11-24, approved by the user)
**Target file:** `.claude/skills/live-db-smoke/SKILL.md` § Safety rules
**Promotion rule used:** a rule that caused a wrong result gets reworded. Under Supabase CLI v3, `npx supabase status -o env` prints plain `NAME="value"` lines with no `export`, so the skill's `eval ... && node` sets shell variables that the `node` child never sees, and the script stops with "missing env".

## Exact change

Old:
```
Load them inline, in the same shell command that runs the script: `eval "$(npx supabase status -o env)" && node <script>.mjs`.
```

New:
```
Load them inline, in the same shell command that runs the script: `set -a && eval "$(npx supabase status -o env)" && set +a && node <script>.mjs`. `set -a` is required: the CLI (v3) prints plain `NAME="value"` lines, so without it the variables never reach `node`.
```

## Evidence (docs/lessons/log.md)
- "2026-11-24: live-db-smoke's env loading didn't export the keys [area: testing]"
