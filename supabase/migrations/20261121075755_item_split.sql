-- M1b + M2, Task 5: set_item_split, so any current claimer of a row can set every claimer's
-- parts on that row (Amendment A1.2).
-- Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Functions and Realtime", design
-- decision 5, A2.3, criteria 45-52). Earlier migrations are not edited.
--
-- There is deliberately NO claimer-change trigger (A2.3): parts are kept when people claim or
-- unclaim. A newcomer gets the column default of 1; nobody else's parts change.
--
-- Error contract (fixed SQLSTATE + message; the app maps only these):
--   42501 'not_allowed'      no signed-in user, or the caller has no claim on this row
--   P0002 'not_found'        no such row, or the caller isn't a participant of its bill
--                            (same error either way, so outsiders learn nothing)
--   22023 'invalid_parts'    p_parts isn't an object of { "<uuid>": integer 1..20 }
--   22023 'claimers_changed' the keys aren't exactly the row's current claimers (someone joined
--                            or left the row meanwhile); the client refetches

-- ---------------------------------------------------------------------------
-- public.set_item_split
-- ---------------------------------------------------------------------------
-- security definer: clients have no update grant on claims at all (A1.2), and the caller sets
-- OTHER people's parts. That needs a check a column grant can't express ("is the caller a
-- current claimer of this row"). Its guard list is the security boundary:
--   1. signed in; 2. the row exists and the caller is a participant of its bill;
--   3. the row and its claims are locked; 4. the caller is a current claimer of the row;
--   5. p_parts names exactly the current claimers, each with an integer 1..20;
--   6. it updates parts on THIS row's claims only, plus split_set_by/at on this row.
-- It never inserts or deletes claims and never touches another row.
create function public.set_item_split(p_line_item_id uuid, p_parts jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- The row, locked FOR UPDATE. That also blocks a concurrent claim insert on this row (its
  -- foreign key check needs a KEY SHARE lock on the row) until this transaction ends.
  select li.bill_id into v_bill_id
  from public.line_items as li
  where li.id = p_line_item_id
  for update;

  if v_bill_id is null
     or not exists (
       select 1 from public.bill_participants as bp
       where bp.bill_id = v_bill_id and bp.user_id = v_uid
     ) then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  -- Lock the row's current claims so nobody can unclaim while the split is written.
  perform 1 from public.claims as c where c.line_item_id = p_line_item_id for update;

  if not exists (
    select 1 from public.claims as c
    where c.line_item_id = p_line_item_id and c.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Shape: an object whose keys are uuids (no two spelling the same uuid) and whose values are
  -- JSON integers 1..20 (not 1.5, not "2").
  if p_parts is null or jsonb_typeof(p_parts) <> 'object'
     or exists (
       select 1 from jsonb_each(p_parts) as kv
       where kv.key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not private.jsonb_int_between(kv.value, 1, 20)
     )
     or (select count(*) from jsonb_object_keys(p_parts))
        <> (select count(distinct k::uuid) from jsonb_object_keys(p_parts) as k) then
    raise exception using errcode = '22023', message = 'invalid_parts';
  end if;

  -- Exactly the current claimer set: no one added, no one left out.
  if exists (
       select 1 from jsonb_object_keys(p_parts) as k
       where not exists (
         select 1 from public.claims as c
         where c.line_item_id = p_line_item_id and c.user_id = k::uuid
       )
     )
     or exists (
       select 1 from public.claims as c
       where c.line_item_id = p_line_item_id
         and not exists (
           select 1 from jsonb_object_keys(p_parts) as k where k::uuid = c.user_id
         )
     ) then
    raise exception using errcode = '22023', message = 'claimers_changed';
  end if;

  update public.claims as c
  set parts = (kv.value::text)::integer
  from jsonb_each(p_parts) as kv
  where c.line_item_id = p_line_item_id
    and c.user_id = kv.key::uuid;

  update public.line_items as li
  set split_set_by = v_uid,
      split_set_at = now()
  where li.id = p_line_item_id;
end;
$$;

revoke execute on function public.set_item_split(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_item_split(uuid, jsonb) to authenticated;
