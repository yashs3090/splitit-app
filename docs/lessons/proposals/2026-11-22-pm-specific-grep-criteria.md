# Proposal: grep criteria target the forbidden thing and are tried once by the PM

**Status:** applied 2026-11-22
**Target file:** `.claude/agents/product-manager.md` § Rules
**Promotion rule used:** the third grep-based check that gave the wrong answer (M0: the leak check matched its own guard; M1a: `git grep` skipped untracked files; M1b+M2: criterion 107 matched the style name `styles.message`). The first two were false negatives (fixed in `qa-tester`); this one is a false positive caused by how the criterion was written.

## Exact change

Old:
```
- Write grep-based criteria with plain `grep -rn` unless the files are committed (`git grep` skips untracked files).
```

New:
```
- Write grep-based criteria with plain `grep -rn` unless the files are committed (`git grep` skips untracked files). Make the pattern target the forbidden thing specifically (quotes around a user-facing string, word boundaries `\b`, the call shape such as `Alert.alert(`), not a bare word that also appears in identifiers or styles. Run it once on the current tree and note what it matches today.
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: Build guard literals so leak-check grep doesn't match them [area: testing]"
- "2026-11-21: `git grep` checks pass vacuously when files are untracked [area: testing]"
- "2026-11-22: A grep criterion matched an unrelated identifier [area: testing]"
