-- People you've split with, Task 2: remove_participant, leave_bill (rule L3) and a broadcast
-- when participant rows are deleted.
-- Spec: docs/specs/2026-11-24-people-and-invites.md (D2 L3, D3; criteria 15-22).
-- Builds on 20261124091041_people.sql (bill_participants.added, the participant_removed and
-- left kinds). Earlier migrations are applied and are not edited.
--
-- L3 removable(bill, T): T is a participant, not the host, not the payer (bills.payer_id), has 0
-- claims rows on the bill and no "I paid" mark (settled_at is null). Defined once, in
-- private.is_removable; both functions call it after taking their locks.
--
-- Locks (criterion 21), in this order on every path (bill row first, then participant row):
--   1. SELECT ... FOR UPDATE on the bills row. Serializes with set_payer (FOR UPDATE),
--      mark_paid / unmark_paid (FOR SHARE) and add_participant (FOR SHARE), so the payer and the
--      marks checked are the ones in force when the row is deleted. The bill_participants
--      reset-payer trigger later takes FOR UPDATE on the same bill row, which this transaction
--      already holds, so no lock upgrade can deadlock.
--   2. SELECT ... FOR UPDATE on the target's bill_participants row.
--   3. Only then, in a new statement (a fresh READ COMMITTED snapshot), the L3 check.
-- Why a simultaneous claim is never silently cascaded away: a claim insert (set_claim, or a
-- direct insert under RLS) checks claims_participant_fkey, which takes FOR KEY SHARE on the
-- referenced bill_participants row. FOR KEY SHARE conflicts with FOR UPDATE (Postgres explicit
-- row-lock conflict table). So either
--   * the claim's transaction got its FOR KEY SHARE first: our FOR UPDATE waits for it to commit
--     or roll back, and the L3 check (a later statement) sees the committed claim and refuses
--     (cannot_remove / cannot_leave); or
--   * we got FOR UPDATE first: the claim's FK check waits, then finds the row deleted and fails
--     with 23503, which set_claim maps to P0002 not_found.
-- Marks behave the same way: mark_paid needs FOR SHARE on the bill row, which waits for step 1.
--
-- Event details (lib/activityText.ts parses them; ids only):
--   participant_removed { user_id: uid }   actor = host
--   left                {}                 actor = the person who left
-- Because L3 refuses the payer and anyone with claims, the delete cascades no claims (no
-- unclaimed events) and bill_participants_reset_payer does nothing (no payer_changed).
--
-- Columns clients can't read: none on bill_participants (unchanged; table-level SELECT).

-- ---------------------------------------------------------------------------
-- private.is_removable (L3)
-- ---------------------------------------------------------------------------
-- security invoker, not executable by any client role: only called from the security definer
-- functions below (as their owner).
create function private.is_removable(p_bill_id uuid, p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.bill_participants as bp
    join public.bills as b on b.id = bp.bill_id
    where bp.bill_id = p_bill_id
      and bp.user_id = p_user_id
      and bp.user_id <> b.host_id
      and bp.user_id <> b.payer_id
      and bp.settled_at is null
      and not exists (
        select 1 from public.claims as c
        where c.bill_id = p_bill_id and c.user_id = p_user_id
      )
  );
$$;

revoke execute on function private.is_removable(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.remove_participant(p_bill_id, p_user_id)
-- ---------------------------------------------------------------------------
--   signed out, no such bill, or caller not the host   42501 not_allowed
--   target not a participant (or null)                  no-op: nothing changes, no event
--   L3 false (host, payer, a claim, a mark)             22023 cannot_remove
-- Otherwise deletes the row and logs one participant_removed.
create function public.remove_participant(p_bill_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  for update;
  if not found then
    return;
  end if;

  if not private.is_removable(p_bill_id, p_user_id) then
    raise exception using errcode = '22023', message = 'cannot_remove';
  end if;

  delete from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id;

  perform private.log_event(
    p_bill_id, v_uid, 'participant_removed', null,
    jsonb_build_object('user_id', p_user_id)
  );
end;
$$;

revoke execute on function public.remove_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_participant(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.leave_bill(p_bill_id)
-- ---------------------------------------------------------------------------
--   signed out, no such bill, or caller not a participant   42501 not_allowed
--   L3 false for the caller (host, payer, a claim, a mark)  22023 cannot_leave
-- Otherwise deletes the caller's row and logs one left. Same locks as remove_participant.
create function public.leave_bill(p_bill_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1
  from public.bills as b
  where b.id = p_bill_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = v_uid
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if not private.is_removable(p_bill_id, v_uid) then
    raise exception using errcode = '22023', message = 'cannot_leave';
  end if;

  delete from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = v_uid;

  perform private.log_event(p_bill_id, v_uid, 'left', null, '{}'::jsonb);
end;
$$;

revoke execute on function public.leave_bill(uuid) from public, anon, authenticated;
grant execute on function public.leave_bill(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: one hint per bill per statement when participant rows are deleted
-- ---------------------------------------------------------------------------
-- broadcast_bill_change reads bill ids from old_rows on DELETE
-- (20261121075448_bill_edit_realtime.sql). A bill deleted outright also cascades here; its
-- topic has no listeners left that can read it, and the hint carries no data.
create trigger bill_participants_broadcast_delete
  after delete on public.bill_participants
  referencing old table as old_rows
  for each statement
  execute function private.broadcast_bill_change();
