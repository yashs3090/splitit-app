-- People you've split with: database review fixes (spec docs/specs/2026-11-24-people-and-invites.md;
-- review R1, R4, R6 / decision PI-R-1). Earlier migrations are applied and are not edited; this
-- header corrects their lock-order statements.
--
-- ---------------------------------------------------------------------------
-- Lock order (corrects the "Locks" notes in 20261124091041_people.sql and
-- 20261124091042_membership.sql)
-- ---------------------------------------------------------------------------
-- Rule: every path that locks rows of one bill takes the BILLS ROW FIRST, then line_items /
-- bill_participants / claims rows. That includes the implicit locks of foreign-key checks: an
-- insert into a referencing table takes FOR KEY SHARE on the referenced row, and every
-- private.log_event insert takes FOR KEY SHARE on the bills row (bill_events_bill_id_fkey).
--
-- What the earlier headers got wrong (review R1): they said a claim only takes FOR KEY SHARE on
-- the bill_participants row. A claim insert takes, in this order:
--   1. FOR KEY SHARE on line_items and bill_participants (claims' foreign keys), then
--   2. FOR KEY SHARE on bills, through claims_log_event -> log_event -> bill_events' foreign key.
-- remove_participant / leave_bill take FOR UPDATE on bills, then FOR UPDATE on the participant
-- row. Opposite orders: the two could deadlock (40P01). The same shape existed between
-- update_bill (bills FOR UPDATE, then line_items / claims through its deletes) and set_claim or
-- set_item_split (line item / claims rows first, then bills through log_event).
--
-- Fixed here:
--   * private.lock_bill_key_share(bill): security definer helper that takes FOR KEY SHARE on the
--     bills row, only when the caller is a participant of that bill. FOR KEY SHARE needs the
--     UPDATE privilege, which clients don't have on bills, so set_claim (security invoker) can't
--     lock inline.
--   * set_claim calls it before its insert or delete.
--   * claims_lock_bill_first: a BEFORE INSERT row trigger on claims calls it too, so a direct
--     insert under RLS (authenticated still has INSERT on claims) follows the same order.
--     BEFORE INSERT triggers run before the row is written and before any foreign-key check.
--   * set_item_split locks the bill (helper) before its FOR UPDATE on the line item.
--   * join_bill takes FOR KEY SHARE on the bills row in its lookup, before it inserts or updates
--     the participant row (it now can update one: R6 below).
-- FOR KEY SHARE conflicts only with FOR UPDATE (and DELETE / key updates). So a claim and
-- remove_participant / leave_bill / update_bill / set_payer / rotate_join_code /
-- set_extras_split now queue on the bills row, and the second one starts only after the first
-- commits. Claims still run alongside each other, add_participant (FOR SHARE) and mark_paid /
-- unmark_paid (FOR SHARE). The outcome of a claim racing a remove is as the membership header
-- describes (cannot_remove / cannot_leave, or the claim fails 23503 -> P0002 not_found), only
-- decided at the bills row instead of the participant row.
--
-- Already in this order, unchanged: create_bill, rotate_join_code, update_bill, set_extras_split,
-- set_payer, mark_paid, unmark_paid, add_participant, remove_participant, leave_bill.
--
-- Not fixed here (no client code uses them; see the report / docs/before-production.md):
--   * A direct DELETE on claims through the Data API (authenticated keeps DELETE on claims)
--     locks the claim row before any trigger can run (Postgres locks the row before BEFORE
--     DELETE row triggers), then takes FOR KEY SHARE on bills via claims_log_event. Against
--     update_bill that is the old order. The app unclaims only through set_claim. Revoking
--     direct INSERT/DELETE on claims would close it; that is a grant change for the user to
--     decide.
--   * Account deletion: the auth.users cascade deletes bill_participants rows before
--     bill_participants_reset_payer locks the bill (review R9 of the settle spec, already in
--     docs/before-production.md).
--
-- Not testable in pgTAP: a real two-session deadlock (pgTAP runs in one transaction on one
-- connection). supabase/tests/database/people_review_fixes.test.sql checks the order instead:
-- the helper runs before the claim row exists, and the function bodies call it before their
-- writes.
--
-- ---------------------------------------------------------------------------
-- R4: leave_bill checks participation without a lock first
-- ---------------------------------------------------------------------------
-- A caller who isn't a participant (or a missing bill) gets 42501 not_allowed without taking the
-- FOR UPDATE on the bills row, so a stranger can't make the bill's writers wait. A participant
-- then takes the locks (bill, then their row) and the participation and L3 checks are repeated
-- under the lock. Errors and their order are unchanged.
--
-- ---------------------------------------------------------------------------
-- R6 (decision PI-R-1): opening the link as an added participant counts as joining
-- ---------------------------------------------------------------------------
-- join_bill on a bill where the caller's row has added = true sets added = false and logs one
-- joined event (actor = the caller, details {}), as a first join does. A repeat join of a row
-- that is already added = false still changes nothing and logs nothing. The flip is a plain
-- UPDATE ... WHERE added, so an ordinary repeat join locks no participant row. The update fires
-- bill_participants_broadcast_update, so open bill screens refetch. join_bill's signature,
-- return value and errors are unchanged.
-- bill_participants.added can now change once, true -> false, and only through join_bill.
--
-- Columns clients can't read: none on bill_participants or claims (unchanged; table-level
-- SELECT). profiles is unchanged: clients read (id, display_name, venmo_username) only.

-- ---------------------------------------------------------------------------
-- private.lock_bill_key_share
-- ---------------------------------------------------------------------------
-- security definer (owner postgres): clients lack the UPDATE privilege that FOR KEY SHARE needs.
-- Only a participant's call locks anything, so a client can't use it to hold locks on other
-- people's bills. Executable by authenticated because set_claim (security invoker) and the
-- claims trigger run as the client; the private schema isn't exposed through the Data API.
create function private.lock_bill_key_share(p_bill_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.bills as b
  where b.id = p_bill_id
    and exists (
      select 1 from public.bill_participants as bp
      where bp.bill_id = b.id and bp.user_id = (select auth.uid())
    )
  for key share of b;
end;
$$;

alter function private.lock_bill_key_share(uuid) owner to postgres;
revoke execute on function private.lock_bill_key_share(uuid) from public, anon, authenticated;
grant execute on function private.lock_bill_key_share(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- claims: lock the bill before any claim insert (covers direct inserts under RLS)
-- ---------------------------------------------------------------------------
create function private.claims_lock_bill_first()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_bill_key_share(new.bill_id);
  return new;
end;
$$;

alter function private.claims_lock_bill_first() owner to postgres;
revoke execute on function private.claims_lock_bill_first() from public, anon, authenticated;

create trigger claims_lock_bill_first
  before insert on public.claims
  for each row
  execute function private.claims_lock_bill_first();

-- ---------------------------------------------------------------------------
-- public.set_claim (body from 20261122085802 plus the bill lock before the write)
-- ---------------------------------------------------------------------------
create or replace function public.set_claim(p_line_item_id uuid, p_claimed boolean)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_claimed is null then
    raise exception using errcode = '22023', message = 'invalid_claim';
  end if;

  -- Under RLS: a row of a bill the caller isn't in is invisible, same as a missing row.
  select li.bill_id into v_bill_id from public.line_items as li where li.id = p_line_item_id;
  if v_bill_id is null then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;

  -- Lock order: the bills row first, before any claim, line item or participant row lock.
  perform private.lock_bill_key_share(v_bill_id);

  if p_claimed then
    begin
      insert into public.claims (bill_id, line_item_id, user_id)
      values (v_bill_id, p_line_item_id, v_uid)
      on conflict (line_item_id, user_id) do nothing;
    exception when foreign_key_violation then
      -- The row (or the caller's participant row) was deleted after the read above, e.g. by the
      -- host's concurrent update_bill or remove_participant. To the caller that is the same as a
      -- missing row.
      raise exception using errcode = 'P0002', message = 'not_found';
    end;
  else
    delete from public.claims as c
    where c.line_item_id = p_line_item_id and c.user_id = v_uid;
  end if;
end;
$$;

revoke execute on function public.set_claim(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_claim(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- public.set_item_split (body from 20261121080352; the bill is locked before the line item)
-- ---------------------------------------------------------------------------
create or replace function public.set_item_split(p_line_item_id uuid, p_parts jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
  v_name text;
  v_unit integer;
  v_size integer;
  v_before jsonb;
  v_after jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Lock order: the bills row first. A line item never moves between bills, so the unlocked read
  -- of bill_id is safe; the locked read below re-checks that the row still exists.
  select li.bill_id into v_bill_id from public.line_items as li where li.id = p_line_item_id;
  if v_bill_id is not null then
    perform private.lock_bill_key_share(v_bill_id);
  end if;

  -- The row, locked FOR UPDATE. That also blocks a concurrent claim insert on this row (its
  -- foreign key check needs a KEY SHARE lock on the row) until this transaction ends.
  select li.bill_id, li.name, li.unit_index, li.group_size into v_bill_id, v_name, v_unit, v_size
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

  select jsonb_object_agg(c.user_id::text, c.parts) into v_before
  from public.claims as c where c.line_item_id = p_line_item_id;

  update public.claims as c
  set parts = (kv.value::text)::integer
  from jsonb_each(p_parts) as kv
  where c.line_item_id = p_line_item_id
    and c.user_id = kv.key::uuid;

  update public.line_items as li
  set split_set_by = v_uid,
      split_set_at = now()
  where li.id = p_line_item_id;

  select jsonb_object_agg(c.user_id::text, c.parts) into v_after
  from public.claims as c where c.line_item_id = p_line_item_id;

  if v_after is distinct from v_before then
    perform private.log_event(
      v_bill_id, v_uid, 'split_changed', v_name,
      jsonb_build_object(
        'unit', case when v_size > 1 then jsonb_build_array(v_unit, v_size) end,
        'before', v_before,
        'after', v_after
      )
    );
  end if;
end;
$$;

revoke execute on function public.set_item_split(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_item_split(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- public.join_bill (body from 20261121080352; bill locked in the lookup; R6 flip)
-- ---------------------------------------------------------------------------
create or replace function public.join_bill(p_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
  v_changed integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_code is null or p_code !~ '^[0-9a-f]{20}$' then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  -- Lock order: the bills row first (the caller may not be a participant yet, so this is inline
  -- rather than private.lock_bill_key_share).
  select b.id into v_bill_id from public.bills as b where b.join_code = p_code for key share;
  if v_bill_id is null then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  insert into public.bill_participants (bill_id, user_id)
  values (v_bill_id, v_uid)
  on conflict (bill_id, user_id) do nothing;
  get diagnostics v_changed = row_count;

  if v_changed = 0 then
    -- PI-R-1: an added participant who opens the link has joined.
    update public.bill_participants as bp
    set added = false
    where bp.bill_id = v_bill_id and bp.user_id = v_uid and bp.added;
    get diagnostics v_changed = row_count;
  end if;

  if v_changed > 0 then
    perform private.log_event(v_bill_id, v_uid, 'joined', null, '{}'::jsonb);
  end if;

  return v_bill_id;
end;
$$;

revoke execute on function public.join_bill(text) from public, anon, authenticated;
grant execute on function public.join_bill(text) to authenticated;

comment on column public.bill_participants.added is
  'True when the row was created by add_participant (the host added this person). Rows from '
  'create_bill and join_bill are false. join_bill sets it to false when an added person opens '
  'the link (PI-R-1); nothing else changes it. Used only by rule L1.';

-- ---------------------------------------------------------------------------
-- public.leave_bill (R4: unlocked participation check first)
-- ---------------------------------------------------------------------------
--   signed out, no such bill, or caller not a participant   42501 not_allowed
--   L3 false for the caller (host, payer, a claim, a mark)  22023 cannot_leave
create or replace function public.leave_bill(p_bill_id uuid)
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

  -- No lock yet: a non-participant (or a missing bill) is refused without waiting on the bill.
  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Locks: bills row, then the caller's row; both re-checked under the lock.
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
