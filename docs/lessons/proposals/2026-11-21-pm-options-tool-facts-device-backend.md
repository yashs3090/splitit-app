# Proposal: product-manager asks before defaulting, verifies tool facts, plans device access

**Status:** applied 2026-11-21
**Target file:** `.claude/agents/product-manager.md` § Rules
**Promotion rule used:** "A lesson in the same area seen twice or more becomes a rule in the agent that should have caught it" (retro SKILL.md §2). Two lessons have now happened twice, and both are PM lessons:
- PM picks the cheaper option without asking: M0 (email sign-in) and M1a (paste box instead of an item form).
- Spec states tool behavior that isn't true: M0 (`enable_signup` key) and M1a (criterion 54; Tesseract PSM 4).

The device-backend rule is a first occurrence. It's included because it belongs to the same "Rules" list and costs one line; drop it if you'd rather wait for a repeat.

## Exact change

Old:
```
## Rules
- Prefer the smallest version that tests the riskiest assumption.
- Money math, privacy and RLS always get explicit acceptance criteria.
- Write only under `docs/`. Never edit code.
- Return the spec path and a 5-line summary.
```

New:
```
## Rules
- Prefer the smallest version that tests the riskiest assumption.
- Money math, privacy and RLS always get explicit acceptance criteria.
- **Ask, don't default.** Start the spec with a "Providers, accounts and costs" table (every external service or account it needs, with setup cost). When a user-facing feature has more than one reasonable shape (e.g. a paste box vs an item form for manual entry), write the options with a one-line trade-off under open questions and recommend one. Don't write tasks that depend on the choice until the user answers. "Smallest version" means fewest features, not the cheapest form of a feature the user asked for.
- **Tool facts are verified or marked.** Any config key, flag, parameter value or criterion that depends on what a tool does (what a build output contains, which setting works) is checked against the installed version first, or marked "verify; reword if the tool differs". Word such criteria as the property being protected (e.g. "no native JS bundle contains X"), not as one way of checking it (e.g. "grep the whole export folder"). Tunable parameters are "starting value"; the implementer may change them with evidence.
- **Device checks say how the device reaches the backend.** On a physical phone `127.0.0.1` is the phone itself. If an on-device check needs Supabase, say how it gets there (the Mac's LAN IP plus matching OAuth redirect URLs, a tunnel, or a hosted project), or mark the check blocked until that exists.
- Write grep-based criteria with plain `grep -rn` unless the files are committed (`git grep` skips untracked files).
- Write only under `docs/`. Never edit code.
- Return the spec path and a 5-line summary.
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: Ask the user about providers and setup costs before speccing [area: process]"
- "2026-11-21: PM defaulted a user-facing choice again; offer the options [area: process]"
- "2026-11-19: Check spec'd config keys against the installed tool version [area: process]"
- "2026-11-21: Specs asserted tool behavior that turned out false [area: process]"
- "2026-11-21: On a physical phone, `127.0.0.1` is the phone [area: expo]"
- "2026-11-21: `git grep` checks pass vacuously when files are untracked [area: testing]"
- Spec `docs/specs/2026-11-20-m1a-scan-receipt.md`: Amendments A1.3, A4.1, A4.4, A5.
