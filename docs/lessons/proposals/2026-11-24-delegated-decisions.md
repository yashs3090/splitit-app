# Proposal: a written rule for delegated decisions, with convention departures raised to the user

**Status: pending**

**Targets:** `.claude/agents/product-manager.md` (Rules), `.claude/skills/build-task/SKILL.md` (steps 1 and 7)

**Promotion rule used:** the same lesson twice in the log (process area). Today the rule exists only in the log and in a session memory.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "User delegated UX decisions: decide, log for review, keep building" [process]: first occurrence (first-total-as-subtotal, A3). It said "promote to `product-manager` and `build-task` if it recurs".
- 2026-11-24 "Delegated decisions, second time: about 40 logged, one departed from a CLAUDE.md convention" [process]: M3. The slice shipped without stopping, but entries came in four formats, one decision was logged three times (M3-6, M3-B-12, M3-R-1), and the K6 app/DB difference departed from CLAUDE.md § Conventions under "don't block".
- 2026-11-24 "Delegated decisions, third time: one reversed a privacy choice, and the main session's tables dropped 'Why'" [process]: people and invites (added in that slice's retro). PI-N-1 reversed PI-19's "no contacts permission"; native-mobile flagged it "needs your review" on its own, but no rule puts permissions in the summary. The main session's PI-M-1 and PI-R-1 to PI-R-4 tables had no Why column. Changes 1–3 below were extended for both.
- 2026-11-24 "Delegated decisions, fourth time: 18 decided without a stop; a money decision was built and flagged" [process] (added in the claimable-discounts retro): the PM decided CD-1 … CD-18 and the build never stopped. CD-6 (negative shares) is a money decision. As Change 1 is written, it would have stopped the build as an open question. Instead the PM built it and marked it "needs your look", which matched "keep building". See "Your choice before applying" below.

- 2026-11-25, Venmo note and Request buttons slices (no separate log entry; the pattern held): VN-1 … VN-11 and VR-1 … VR-18, VR-R1 … VR-R6 were decided and logged without a stop. VR-5 (what the payer can collect in one tap) was built and marked "Money: needs your look", and VN-8 (item names on by default in Venmo notes) was raised in `docs/before-production.md` as "needs your look". Both follow option (b) below, and the "Privacy:" wording in Change 1 would cover VN-8.

- 2026-11-25 "Delegated decisions, fifth time: a decision listed two options and missed a third" [process] (added in the visual-pass retro): the main session decided VP-M1, VP-M2 and VP-M3 without stopping and raised P13 to the user, as this proposal describes. Review R11 found VP-M3 weighed "intercept back or not" and left out intercepting Android's `BackHandler` only. Suggested addition to Change 1, at the end of the new bullet: "When a decision is about platform behavior, the alternatives include the per-platform options (native only, Android only, web only)."

## Your choice before applying (added 2026-11-24, claimable-discounts retro)
Change 1 says money decisions "still go to the user as open questions", and build-task step 1 then stops to ask you. In claimable discounts the PM didn't stop on CD-6: it built the option that's easiest to change and flagged it. Pick one:
- **(a) Keep Change 1 as written.** Money questions stop the build until you answer, even when you've said to keep building.
- **(b) Money decisions are built and flagged, not blocking.** In Change 1, replace "Three kinds still go to the user as open questions: money (what someone owes or is shown as owing), providers and accounts, and hard-to-reverse choices." with "Providers and accounts, and hard-to-reverse choices, still go to the user as open questions. A money decision (what someone owes or is shown as owing) doesn't block: pick the option that's easiest to reverse, build it, and start its Why with \"Money:\"." In Change 2, replace "Money, providers and hard-to-reverse choices still come back to you" with "Providers and hard-to-reverse choices still come back to you; money decisions are built and logged with \"Money:\"". In Change 3, replace "(\"Departs from …\" and \"Privacy: …\" rows" with "(\"Departs from …\", \"Privacy: …\" and \"Money: …\" rows".

Recommendation: (b). It's what happened in this slice and in M3 (except Q10, which you were asked about), and it fits your "keep building" direction. Pick (a) if you'd rather see every money call before anything is built on it.

## Change 1: `.claude/agents/product-manager.md`, new bullet in Rules, directly before "Tool facts are verified or marked."

Old:
```
- **Tool facts are verified or marked.**
```
(Insert the bullet directly before this line; the line itself stays unchanged. This doesn't touch the lines the pending parser proposal edits.)

New (inserted):
```
- **When the user delegates decisions** ("keep building, log decisions"), the ask-don't-default rule changes for that task. Decide, give a one-line reason, and log each decision in `docs/decisions-to-review.md` under the task's heading, one table row per decision: `| id | decision | picked | alternatives | why | status |`. If a decision changes later, update its row (status `Changed: …`) instead of adding a new id. Three kinds still go to the user as open questions: money (what someone owes or is shown as owing), providers and accounts, and hard-to-reverse choices. A decision that departs from `CLAUDE.md` or an ADR doesn't block the build, but its Why starts with "Departs from <rule>:", and the build summary raises it. The same goes for a decision that adds an OS permission prompt, reads personal data the app didn't read before (contacts, location, photos), or reverses an earlier privacy decision: its Why starts with "Privacy:".
```

## Change 2: `.claude/skills/build-task/SKILL.md`, step 1

Old:
```
1. **Spec:** run the `product-manager` agent with the milestone or feature. It returns a spec path under `docs/specs/`. If the spec lists open questions that only the user can decide, ask the user before going on.
```

New:
```
1. **Spec:** run the `product-manager` agent with the milestone or feature. It returns a spec path under `docs/specs/`. If the spec lists open questions that only the user can decide, ask the user before going on.
   - **Delegated decisions:** if the user has said to keep building and log decisions, tell every agent you spawn to decide, log in `docs/decisions-to-review.md` using the PM's row format, and not stop. Use the same format, Why column included, for decisions you make yourself (review or live-check decisions). Money, providers and hard-to-reverse choices still come back to you, so you can ask the user.
```

## Change 3: `.claude/skills/build-task/SKILL.md`, step 7, new bullet after the first one

Old:
```
   - open user actions reported in an earlier task and still not done (e.g. "still open since M1a: move the Google variables out of the root `.env`"), first, with one line on why each matters
```

New:
```
   - open user actions reported in an earlier task and still not done (e.g. "still open since M1a: move the Google variables out of the root `.env`"), first, with one line on why each matters
   - decisions made on the user's behalf that depart from `CLAUDE.md` or an ADR, or touch privacy ("Departs from …" and "Privacy: …" rows in `docs/decisions-to-review.md`), each with its id and one line, so the user can approve the exception or ask for the change; then how many other decisions are open for review
```

## What this changes for you
When you say "keep building", every agent will log decisions the same way, one row each, and the summary will put the few that bend a written project rule (like this slice's K6 app/DB difference) at the top, so you don't have to dig through about 40 rows to find them. Decisions that add a permission prompt or read new personal data (like this slice's contacts access, PI-N-1) go up there too.
