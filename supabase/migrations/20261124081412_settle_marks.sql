-- M3 Task 2: "the bill is complete" (C1), mark_paid and unmark_paid (C2, C3), with their
-- Activity events (C4, Q9: both are logged).
-- Spec: docs/specs/2026-11-24-m3-settle-venmo.md (criteria 14-23). Builds on
-- 20261124081411_settle_payer.sql (mark columns, payer_id, the event kinds, the update broadcast).
--
-- Event details written here (lib/activityText.ts parses them):
--   marked_paid   { payer_id: uid, cents: int }   actor = the person who marked
--   unmarked_paid { user_id: uid, cents: int }    actor = whoever undid it; cents = the cleared
--                                                 mark's settled_cents
--
-- Locking: both functions take FOR SHARE on the bill row. That runs them one after the other
-- with set_payer (FOR UPDATE), so a mark can't land between set_payer's count and its clear,
-- while two people marking at the same time don't wait on each other. The participant row
-- itself is changed with a conditional update / FOR UPDATE, so a double tap logs one event.
--
-- Columns clients can't read: none on bills or bill_participants (table-level SELECT).

-- ---------------------------------------------------------------------------
-- private.bill_is_complete (C1): every line_items row of the bill has at least one claim
-- ---------------------------------------------------------------------------
-- security invoker: it is only called from security definer functions (as their owner). No
-- client role may execute it. A bill with no rows is vacuously complete (create_bill never makes
-- one: validate_bill_rows requires at least one row).
create function private.bill_is_complete(p_bill_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (
    select 1
    from public.line_items as li
    where li.bill_id = p_bill_id
      and not exists (select 1 from public.claims as c where c.line_item_id = li.id)
  );
$$;

revoke execute on function private.bill_is_complete(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.mark_paid
-- ---------------------------------------------------------------------------
-- Checks, in this order (the app's error mapping relies on it):
--   signed out, no such bill, or caller not a participant  42501 not_allowed
--   p_cents null or outside 1..99999999 (C2)               22023 invalid_amount
--   p_payer_id isn't the bill's current payer               22023 payer_changed
--   caller is the payer                                     22023 is_payer
--   bill not complete (C1)                                  22023 not_complete
-- Already marked: no-op (keeps the first settled_at and settled_cents, no event).
create function public.mark_paid(p_bill_id uuid, p_payer_id uuid, p_cents integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_payer uuid;
  v_updated integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.payer_id into v_payer
  from public.bills as b
  where b.id = p_bill_id
  for share;
  if not found or not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_cents is null or p_cents < 1 or p_cents > 99999999 then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;

  if p_payer_id is distinct from v_payer then
    raise exception using errcode = '22023', message = 'payer_changed';
  end if;

  if v_uid = v_payer then
    raise exception using errcode = '22023', message = 'is_payer';
  end if;

  if not private.bill_is_complete(p_bill_id) then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  update public.bill_participants as bp
  set settled_at = now(), settled_cents = p_cents
  where bp.bill_id = p_bill_id and bp.user_id = v_uid and bp.settled_at is null;
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    perform private.log_event(
      p_bill_id, v_uid, 'marked_paid', null,
      jsonb_build_object('payer_id', v_payer, 'cents', p_cents)
    );
  end if;
end;
$$;

revoke execute on function public.mark_paid(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.mark_paid(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- public.unmark_paid (Q4: the host, the person themself, or the payer)
-- ---------------------------------------------------------------------------
-- Signed out, no such bill, caller not a participant, or a caller who is none of host / payer /
-- p_user_id: 42501 not_allowed. The permission check comes before any look at the target, so
-- a disallowed caller learns nothing about it. Target not a participant (or null) or not
-- marked: no-op, no event.
create function public.unmark_paid(p_bill_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_host uuid;
  v_payer uuid;
  v_cents integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.host_id, b.payer_id into v_host, v_payer
  from public.bills as b
  where b.id = p_bill_id
  for share;
  if not found
     or not exists (
       select 1 from public.bill_participants as bp
       where bp.bill_id = p_bill_id and bp.user_id = v_uid
     )
     or (v_uid <> v_host and v_uid <> v_payer and v_uid is distinct from p_user_id) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select bp.settled_cents into v_cents
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id and bp.settled_at is not null
  for update;
  if not found then
    return;
  end if;

  update public.bill_participants as bp
  set settled_at = null, settled_cents = null
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id;

  perform private.log_event(
    p_bill_id, v_uid, 'unmarked_paid', null,
    jsonb_build_object('user_id', p_user_id, 'cents', v_cents)
  );
end;
$$;

revoke execute on function public.unmark_paid(uuid, uuid) from public, anon, authenticated;
grant execute on function public.unmark_paid(uuid, uuid) to authenticated;
