# Proposal: one lock order per bill, counting the locks Postgres takes implicitly

**Status: pending**

**Targets:** `.claude/agents/supabase-engineer.md` (Rules); `.claude/agents/code-reviewer.md` (item 3, Correctness)

**Promotion rule used:** the same lesson twice in the log (rls area). The M3 lesson said "promote to `supabase-engineer` if it recurs", and it did.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "Two concurrency gaps in the settle functions" [rls]: M3 review R9, account-delete cascade and trigger vs `set_payer` / `mark_paid`.
- 2026-11-24 "A second deadlock: the lock argument missed the locks Postgres takes for you" [rls]: people review R1 (`set_claim` took participant then bill through FK checks; `remove_participant` / `leave_bill` took bill then participant; `set_item_split` and `join_bill` had the same shape), R4 (`leave_bill` locked before checking participation), PI-R-3 (direct claim writes still bypass the order). Fixed in `supabase/migrations/20261124094656_people_review_fixes.sql`.
- 2026-11-27 "A third deadlock partner: the migration header said account deletion added 'no new ordering'" [rls] (added in the group claim status retro): review R5; documented in `docs/before-production.md`, not fixed. Evidence for Change 1b.

## Change 1: `.claude/agents/supabase-engineer.md`, new bullet directly after "Child-row inserts don't race the parent."

Old:
```
- Functions: `security definer` only when needed, always `set search_path = ''`, fully qualified names, `revoke execute ... from public, anon, authenticated` unless a client must call it.
```
(Insert the bullet directly before this line; the line itself stays unchanged.)

New (inserted):
```
- **One lock order per bill: the bills row first.** Every function and trigger that locks rows of one bill takes the bills row before any line_items, bill_participants or claims row. Count the locks Postgres takes for you: a foreign-key check takes `FOR KEY SHARE` on the referenced row (inserting a claim locks its item and participant rows; inserting a `bill_events` row locks the bill), and `on delete cascade` and triggers lock more rows. A path that would otherwise reach the bills row last takes it first, explicitly (`private.lock_bill_key_share`, or a BEFORE INSERT trigger as in `20261124094656_people_review_fixes.sql`). The migration header lists each new or changed path's locks in order, implicit ones included. Check who may act (participant, host) before taking any lock, so a caller can't hold locks on a bill they aren't on. If a function enforces the order but clients can also write the table directly, the direct write bypasses it: make the function `security definer` and revoke the direct write, or add the gap to `docs/before-production.md`. pgTAP runs on one connection and can't produce a real deadlock, so test the order (as `people_review_fixes.test.sql` does) and say so in the report. Reference: `supabase-postgres-best-practices` → `lock-deadlock-prevention.md`.
```

## Change 1b (added 2026-11-27, group claim status retro; apply with Change 1): one sentence appended to the Change 1 bullet, after "The migration header lists each new or changed path's locks in order, implicit ones included."

New (inserted after that sentence):
```
That list also walks every existing path that deletes or updates the rows the new code locks (account deletion's cascade, leave, remove), including the triggers those paths fire, and checks each against the new order; "the cascade only adds a row" isn't enough.
```
Evidence: log 2026-11-27 "A third deadlock partner: the migration header said account deletion added 'no new ordering'" [rls]. Review R5 of docs/specs/2026-11-27-group-claim-status.md: `set_not_part` locks bill then participant, while the payer-deletion trigger fired by account deletion locks participant then bill. The header in `20261127150000_bill_not_part.sql` listed its own implicit locks, as Change 1 asks, but didn't check that trigger. This is the third deadlock entry in the rls area. The reviewer found it by checking the header against the code, as Change 2 asks.

## Change 2: `.claude/agents/code-reviewer.md`, item 3 (Correctness), new sentence at the end

Old:
```
Also flag money math from `lib/` that runs repeatedly per render instead of once per data change.
```

New:
```
Also flag money math from `lib/` that runs repeatedly per render instead of once per data change. For SQL functions and triggers that lock rows of the same bill, write down from the code the sequence of row locks each path takes, implicit ones included (FK checks take `FOR KEY SHARE` on the parent row, cascades, triggers, event inserts), and flag any two paths that take the same rows in opposite orders, any lock taken before the caller's permission check, and any direct table grant that lets a client skip the function that enforces the order. Don't rely on the migration header's lock argument; check it.
```

## What this changes for you
Two deadlocks in a row (M3 and this slice) came from the database taking locks nobody wrote down. Database work will now list every lock, including the hidden ones, and reviews will check that list against the code, so the third one should be caught while the migration is written instead of in review.
