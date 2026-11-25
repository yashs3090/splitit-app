# Proposal: the PM shows its grep result; checks that need a person are marked as user checks

**Status:** applied (2026-11-24, approved by the user)
**Target file:** `.claude/agents/product-manager.md` § Rules
**Promotion rules used:**
- Change 1: the fourth grep-based check that gave the wrong answer, and the existing rule ("run it once ... and note what it matches today") didn't stop it. A rule that produced a wrong result gets reworded. The PM has no Bash, so it can't run the criterion's exact `grep -rnF` command, and the "matches nothing today" note wasn't backed by an equivalent search.
- Change 2: first occurrence in this form (criterion 40 partial). It's small and is listed separately so you can take Change 1 alone.

## Change 1

Old:
```
- Write grep-based criteria with plain `grep -rn` unless the files are committed (`git grep` skips untracked files). Make the pattern target the forbidden thing specifically (quotes around a user-facing string, word boundaries `\b`, the call shape such as `Alert.alert(`), not a bare word that also appears in identifiers or styles. Run it once on the current tree and note what it matches today.
```

New:
```
- Write grep-based criteria with plain `grep -rn` unless the files are committed (`git grep` skips untracked files). Make the pattern target the forbidden thing specifically (quotes around a user-facing string, word boundaries `\b`, the call shape such as `Alert.alert(`), not a bare word that also appears in identifiers or styles. A pattern meant to find one definition includes something unique to it (a length bound, the constant's name), not just a character class other validators share. Run the same pattern over the same paths with the Grep tool (regex-escape it if the criterion uses `grep -F`) and paste the files it matches today into the criterion. If you couldn't run an equivalent search, write "not run" instead of "matches nothing", and the implementer runs it first.
```

## Change 2

Old:
```
- **Device checks say how the device reaches the backend.** On a physical phone `127.0.0.1` is the phone itself. If an on-device check needs Supabase, say how it gets there (the Mac's LAN IP plus matching OAuth redirect URLs, a tunnel, or a hosted project), or mark the check blocked until that exists.
```

New:
```
- **Device checks say how the device reaches the backend.** On a physical phone `127.0.0.1` is the phone itself. If an on-device check needs Supabase, say how it gets there (the Mac's LAN IP plus matching OAuth redirect URLs, a tunnel, or a hosted project), or mark the check blocked until that exists.
- **Checks that need a person are marked "User check".** Agents can't get through Google's real sign-in page or tap through the simulator or a phone. Split such a criterion: the part an agent can verify (e.g. with a locally signed session, as in the `live-db-smoke` skill), and a **User check** with exact steps that the build summary hands to the user. QA reports User checks as "for the user", not partial.
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: Build guard literals so leak-check grep doesn't match them [area: testing]"
- "2026-11-21: `git grep` checks pass vacuously when files are untracked [area: testing]"
- "2026-11-22: A grep criterion matched an unrelated identifier [area: testing]"
- "2026-11-24: Spec said a grep "matches nothing today", but it matched [area: testing]"
- "2026-11-24: Checks that need a human weren't planned as user steps [area: process]" (Change 2)
