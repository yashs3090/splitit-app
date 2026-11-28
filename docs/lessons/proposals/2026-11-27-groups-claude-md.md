# Proposal: CLAUDE.md claims convention allows assigning on group bills

**Status: pending**

**Target:** `CLAUDE.md` § Conventions, the RLS and grants bullet (its last sentence)

**Why:** Groups (ADR 0022) let any group member set who had an item on a bill in a group, not only claim for themselves (user decision U-G6, 2026-11-26: "on a friend trip person A will remember what person B got"). You approved this for group bills only. `CLAUDE.md` still says "users write only their own claims", so an agent reading only `CLAUDE.md` would treat `assign_item` as a security bug and try to "fix" it, or block a group task that relies on it. The Groups spec's docs task (T19) wrote the wording below for you to approve. No agent has changed `CLAUDE.md`.

## Evidence
- `docs/specs/2026-11-26-groups-mvp.md`: U-G6, C-G9 (who may do what), C-G12 (`assign_item`), Risks ("Departs from CLAUDE.md"), and T19's "Proposed `CLAUDE.md` wording".
- Decision GR-A1 in `docs/decisions-to-review.md` (any member can assign, reassign or remove a claim on a group bill; still waiting for your look).
- [ADR 0022](../../learning/decisions/0022-groups.md) §7.
- Built and tested: `assign_item` in `supabase/migrations/20261127062139_assign_item.sql` (pgTAP `supabase/tests/database/assign_item.test.sql`, criteria 38–44). Non-group bills are unchanged: `set_claim` still writes only the caller's claim, and a direct write of someone else's claim still fails (criterion 43).

## Change

Old:
```
Only participants can read a bill; only the host edits line items; users write only their own claims.
```

New:
```
Only participants can read a bill; only the host edits line items; users write only their own claims, except on a bill in a group, where any group member may set who had an item through `assign_item` (logged as "Ana assigned Tacos to Ben"; ADR 0022).
```

## Before applying
GR-A1 is still open. It picked "any member can change anyone's claim on a group bill". The alternative was "only the assigner or the assignee can change an assigned claim". This wording fits both, because both go through `assign_item`. If you pick the narrower rule later, add "(the assigner or the assignee only)" after `assign_item`.

## What this changes for you
Agents will know the exception exists, where it lives (one database function, logged in Activity) and that it covers group bills only. The rule for every other bill stays exactly as it is.
