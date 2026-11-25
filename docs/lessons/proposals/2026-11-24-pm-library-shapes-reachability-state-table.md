# Proposal: specs cite library APIs, back "can't happen" with a DB check, and tabulate membership states; amendments update the tests

**Status: pending**

**Targets:** `.claude/agents/product-manager.md` (Rules); `.claude/skills/build-task/SKILL.md` (step 2, Contract reconciliation)

**Promotion rules used:** same lesson twice or more in the log (process area): spec'd tool facts wrong (third time), spec changes not checked against tests (second time), multi-user interaction rules missed (second time; the 2026-11-22 entry said "promote if it recurs"). The "can't happen" sentence is new and rides along because it's the same kind of unbacked claim.

## Evidence (docs/lessons/log.md)
- 2026-11-19 "Check spec'd config keys against the installed tool version", 2026-11-21 "Specs asserted tool behavior that turned out false", 2026-11-24 "The spec assumed a library's API: no permission needed, and phone fields that don't exist" [process]: PI-19's "no permission" and the `digits`/`countryCode` phone shape were both wrong for `expo-contacts` 57.0.9 (PI-N-1). The package wasn't installed when the spec was written.
- 2026-11-24 "A 'can't happen' row was false, and a fixture kept the old answer after the amendment" [process]: M7 → PI-M-1; review R3.
- 2026-11-24 "A spec said an existing test would 'pass without edits', but it asserted the old behavior" [process]: the first "spec change not checked against tests" case.
- 2026-11-22 "Multi-user features need their interaction rules asked up front" and 2026-11-24 "A membership change wasn't specced: added, then opened the link" [process]: review R6 → PI-R-1, PI-R-4.

## Change 1: `.claude/agents/product-manager.md`, Rules, end of the "Tool facts are verified or marked." bullet

Old:
```
Tunable parameters are "starting value"; the implementer may change them with evidence.
```

New:
```
Tunable parameters are "starting value"; the implementer may change them with evidence. The same goes for a library's API that the spec builds on (the fields it returns, the permissions it needs, what differs by platform): cite the installed package's types or source under `node_modules/<pkg>/` (`file:line`). If the package isn't installed yet, mark the shape "unverified", and order the task that installs and checks it before any task built on that shape.
```

(The pending delegated-decisions proposal inserts a bullet *before* this bullet and leaves it unchanged, so the two don't collide.)

## Change 2: `.claude/agents/product-manager.md`, two new bullets in Rules, directly before "Device checks say how the device reaches the backend."

Old:
```
- **Device checks say how the device reaches the backend.**
```
(Insert the two bullets directly before this line; the line itself stays unchanged.)

New (inserted):
```
- **"Can't happen" names what prevents it.** A boundary row or criterion that says a state can't happen names the DB constraint or function check that refuses it (`file:line`). If only the screen prevents it (a hidden button), write "UI hides it; the DB allows it", give the row its DB answer, and add a DB-side criterion.
- **Membership and status states get a state × action table.** When a spec adds or changes who is on a bill or a status (added, joined, left, removed, paid), include a table of every state a person can be in against every action (open the link, be added, be removed, leave, claim, mark paid, delete account), with the result and the event logged in each cell. An empty cell is an open question.
```

## Change 3: `.claude/skills/build-task/SKILL.md`, step 2, end of the Contract reconciliation bullet

Old:
```
Record any mismatch fix as a spec amendment.
```

New:
```
Record any mismatch fix as a spec amendment. Whenever a spec case is amended (after reconciliation, review or QA), grep the tests, fixtures and `docs/learning/` for the case's id and its old expected value or wording, and update them in the same change.
```

(Extended in the claimable-discounts retro, 2026-11-24: "and `docs/learning/`" and "or wording" were added because ADR 0017 still described CD-10 after Amendment A1 changed it. Log entry: 2026-11-24 "Docs went stale: line numbers moved, and an ADR missed the amendment". That makes it the second time an amendment wasn't carried to everything that restates it.)

## What this changes for you
Three kinds of surprise from this slice should move earlier: a library that turns out to need a permission (here, contacts access), a "this can't happen" that the database actually allows (here, "I paid" from someone who owes nothing), and a membership change nobody specced (here, someone you added who then opens the link). After a spec changes, the tests will be updated with it, not left saying the old thing.
