-- M1b + M2, Task 15: the append-only Activity log (bill_events) and its writers.
-- Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Activity log", design decision 8,
-- A1.6, A2.3, A3, criteria 119-131). Earlier migrations are not edited: the five writer
-- functions are re-created here with `create or replace` (same signatures, so their grants stay).
--
-- The `details` shapes are the ones lib/activityText.ts (Task 16) parses. Per kind:
--   bill_created   { items: <number of form items (groups)>, total_cents }
--   joined         {}
--   claimed        { unit: [unit_index (0-based), group_size] | null, split: {uid: parts} | null }
--   unclaimed      same as claimed
--   split_changed  { unit, before: {uid: parts}, after: {uid: parts} }
--   item_added     { qty, price_cents }
--   item_removed   { qty, price_cents, claimer_ids: [uid, ...] }
--   item_changed   any of { name: [b, a], qty: [b, a], price_cents: [b, a], note_changed: true }
--   amounts_changed any of { tax_cents | fees_cents | tip_cents | total_cents |
--                  subtotal_discount_cents | total_discount_cents | discount_cents : [b, a] }
--   link_rotated   {}  (never the code)
-- `unit` is null for a single-unit item. `split` is the row's parts after the change, only when
-- 2+ claimers remain and their parts are not all equal (A2.3). Cents are integers. Events hold
-- user ids and an item-name snapshot only: no emails, no display names, no join codes.
--
-- Realtime: no extra broadcast trigger. Every event is written in the same transaction as a
-- write that already broadcasts on 'bill:<id>' (claims insert/delete/update, bill_participants
-- insert, bills update), so the Activity screen refetches on the same hint.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.bill_events (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  -- A deleted account's events stay and read "Someone".
  actor_id uuid null references public.profiles (id) on delete set null,
  -- extras_split_changed is included now so Task 18 (set_extras_split) needs no constraint change.
  kind text not null
    constraint bill_events_kind_known check (kind in (
      'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
      'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed'
    )),
  -- Snapshot of the item's name at the time, so a removed or renamed item still reads right.
  item_name text null
    constraint bill_events_item_name_length check (item_name is null or char_length(item_name) <= 100),
  details jsonb not null default '{}'::jsonb
    constraint bill_events_details_object check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

comment on table public.bill_events is
  'Append-only Activity log. Written only by database triggers/functions; participants read.';

-- The Activity screen reads a bill's newest events.
create index bill_events_bill_id_created_at_idx on public.bill_events (bill_id, created_at desc);
-- Covers the actor_id foreign key, so deleting a profile doesn't scan every event.
create index bill_events_actor_id_idx on public.bill_events (actor_id) where actor_id is not null;

alter table public.bill_events enable row level security;

create policy "bill_events_select_participant"
  on public.bill_events
  for select
  to authenticated
  using (private.is_bill_participant(bill_id));

-- Participants read; no client role may insert, update or delete (no grant, no policy).
revoke all on public.bill_events from anon, authenticated, public;
grant select on public.bill_events to authenticated;

-- ---------------------------------------------------------------------------
-- Append-only guard
-- ---------------------------------------------------------------------------
-- Blocks UPDATE and DELETE for every role (postgres included), with exactly two exceptions,
-- both foreign-key actions:
--   * DELETE when the event's bill no longer exists: the `on delete cascade` from bills. The
--     cascade runs after the bill row is deleted, so the bill is no longer visible here.
--   * UPDATE that only sets actor_id to null when that profile no longer exists: the
--     `on delete set null` from profiles when an account is deleted.
-- Checking "is the parent gone" was chosen over pg_trigger_depth(), which would also let through
-- any update/delete issued from inside some other trigger.
-- security invoker (the default): foreign-key actions run as the table owner, and only roles
-- that already hold UPDATE/DELETE on the table can reach this trigger at all.
create function private.bill_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.bills as b where b.id = old.bill_id) then
      return old;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.actor_id is not null
       and new.actor_id is null
       and (new.id, new.bill_id, new.kind, new.item_name, new.details, new.created_at)
           is not distinct from
           (old.id, old.bill_id, old.kind, old.item_name, old.details, old.created_at)
       and not exists (select 1 from public.profiles as p where p.id = old.actor_id) then
      return new;
    end if;
  end if;
  raise exception using errcode = '42501', message = 'bill_events_append_only';
end;
$$;

revoke execute on function private.bill_events_append_only() from public, anon, authenticated;

create trigger bill_events_append_only
  before update or delete on public.bill_events
  for each row
  execute function private.bill_events_append_only();

create trigger bill_events_no_truncate
  before truncate on public.bill_events
  for each statement
  execute function private.bill_events_append_only();

-- ---------------------------------------------------------------------------
-- private.log_event: the single insert path. Not executable by any client role.
-- ---------------------------------------------------------------------------
-- security definer: the claims trigger fires as the client's role (authenticated), which has
-- no insert grant on bill_events. The kind and details checks live on the table.
create function private.log_event(
  p_bill_id uuid,
  p_actor uuid,
  p_kind text,
  p_item_name text,
  p_details jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.bill_events (bill_id, actor_id, kind, item_name, details)
  values (p_bill_id, p_actor, p_kind, p_item_name, coalesce(p_details, '{}'::jsonb));
$$;

revoke execute on function private.log_event(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- claimed / unclaimed: row-level AFTER trigger on claims
-- ---------------------------------------------------------------------------
-- A trigger is the only place that sees every claim write: claims are also inserted/deleted
-- directly under RLS, not only through set_claim. AFTER (queued to the end of the statement), so
-- `split` reads the row's claims as they are after the change.
-- Cascades are skipped: when the claim goes because its line item, its bill or its participant
-- row was deleted, the parent is already gone here, so no "removed their claim" is logged
-- (update_bill logs one item_removed listing the claimers instead).
-- The actor is the claim's own user (RLS only lets you insert/delete your own claim).
-- security definer: it fires as the client's role and must call private.log_event.
create function private.log_claim_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill_id uuid;
  v_line_item_id uuid;
  v_user_id uuid;
  v_name text;
  v_unit integer;
  v_size integer;
  v_split jsonb;
begin
  if tg_op = 'INSERT' then
    v_bill_id := new.bill_id; v_line_item_id := new.line_item_id; v_user_id := new.user_id;
  else
    v_bill_id := old.bill_id; v_line_item_id := old.line_item_id; v_user_id := old.user_id;
  end if;

  select li.name, li.unit_index, li.group_size into v_name, v_unit, v_size
  from public.line_items as li
  where li.id = v_line_item_id;
  if not found then
    return null;
  end if;

  if tg_op = 'DELETE' and not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = v_bill_id and bp.user_id = v_user_id
  ) then
    return null;
  end if;

  select case when count(*) >= 2 and count(distinct c.parts) > 1
              then jsonb_object_agg(c.user_id::text, c.parts) end
  into v_split
  from public.claims as c
  where c.line_item_id = v_line_item_id;

  perform private.log_event(
    v_bill_id, v_user_id,
    case when tg_op = 'INSERT' then 'claimed' else 'unclaimed' end,
    v_name,
    jsonb_build_object(
      'unit', case when v_size > 1 then jsonb_build_array(v_unit, v_size) end,
      'split', v_split
    )
  );
  return null;
end;
$$;

revoke execute on function private.log_claim_event() from public, anon, authenticated;

create trigger claims_log_event
  after insert or delete on public.claims
  for each row
  execute function private.log_claim_event();

-- ---------------------------------------------------------------------------
-- public.create_bill: logs bill_created (body otherwise unchanged from 20261121074859)
-- ---------------------------------------------------------------------------
create or replace function public.create_bill(
  p_rows jsonb,
  p_subtotal_cents integer,
  p_tax_cents integer,
  p_fees_cents integer,
  p_tip_cents integer,
  p_subtotal_discount_cents integer,
  p_total_discount_cents integer,
  p_total_cents integer
)
returns table (bill_id uuid, join_code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
  v_code text;
  v_constraint text;
  v_attempt integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform private.validate_bill_rows(
    p_rows, false, p_subtotal_cents, p_tax_cents, p_fees_cents, p_tip_cents,
    p_subtotal_discount_cents, p_total_discount_cents, p_total_cents
  );

  -- 80 random bits as 20 lowercase hex chars. Retry (up to 3 attempts) on a code collision.
  loop
    v_attempt := v_attempt + 1;
    v_code := encode(extensions.gen_random_bytes(10), 'hex');
    begin
      insert into public.bills as b (
        host_id, subtotal_cents, tax_cents, fees_cents, tip_cents, subtotal_discount_cents,
        total_discount_cents, total_cents, join_code
      ) values (
        v_uid, p_subtotal_cents, p_tax_cents, p_fees_cents, p_tip_cents, p_subtotal_discount_cents,
        p_total_discount_cents, p_total_cents, v_code
      )
      returning b.id into v_bill_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bills_join_code_key' or v_attempt >= 3 then
        raise;
      end if;
    end;
  end loop;

  insert into public.line_items (
    bill_id, group_position, unit_index, group_size, name, note, total_cents
  )
  select v_bill_id,
         (e ->> 'group_position')::integer,
         (e ->> 'unit_index')::integer,
         (e ->> 'group_size')::integer,
         btrim(e ->> 'name'),
         case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
         (e ->> 'total_cents')::integer
  from jsonb_array_elements(p_rows) as e;

  insert into public.bill_participants (bill_id, user_id) values (v_bill_id, v_uid);

  -- "items" counts form items (groups), not unit rows: Beer x2 is one item.
  perform private.log_event(
    v_bill_id, v_uid, 'bill_created', null,
    jsonb_build_object(
      'items', (select count(distinct (e ->> 'group_position')::integer)
                from jsonb_array_elements(p_rows) as e),
      'total_cents', p_total_cents
    )
  );

  bill_id := v_bill_id;
  join_code := v_code;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.join_bill: logs joined only when a participant row was actually inserted
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
  v_inserted integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_code is null or p_code !~ '^[0-9a-f]{20}$' then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  select b.id into v_bill_id from public.bills as b where b.join_code = p_code;
  if v_bill_id is null then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  insert into public.bill_participants (bill_id, user_id)
  values (v_bill_id, v_uid)
  on conflict (bill_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    perform private.log_event(v_bill_id, v_uid, 'joined', null, '{}'::jsonb);
  end if;

  return v_bill_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.rotate_join_code: logs link_rotated (details never contain a code)
-- ---------------------------------------------------------------------------
create or replace function public.rotate_join_code(p_bill_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_found uuid;
  v_code text;
  v_constraint text;
  v_attempt integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.id into v_found
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  if v_found is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := encode(extensions.gen_random_bytes(10), 'hex');
    begin
      update public.bills as b set join_code = v_code where b.id = v_found;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bills_join_code_key' or v_attempt >= 3 then
        raise;
      end if;
    end;
  end loop;

  perform private.log_event(v_found, v_uid, 'link_rotated', null, '{}'::jsonb);

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.update_bill: logs one event per changed form item (group), plus amounts_changed
-- ---------------------------------------------------------------------------
-- Body unchanged from 20261121075448 except: the host-check select also reads the old money
-- columns, and the events are computed from the old rows (still in the table) and p_rows just
-- before the rows are written. Everything is one transaction, so a failure logs nothing.
--
-- Group matching (spec decision 8): a new group is matched to an old group through any kept row
-- id; if its kept ids come from several old groups, the lowest old position wins. A new group
-- with no kept ids is item_added. An old group none of whose ids are kept is item_removed, with
-- the users who had claims on any of its units (those claims cascade; the claims trigger skips
-- cascades, so no unclaimed events). A matched pair logs item_changed with only the fields that
-- differ: name (trimmed), qty (group size), price_cents (sum of unit prices) and note_changed.
-- Reordering alone logs nothing.
--
-- amounts_changed carries each changed money field as [before, after]: tax_cents, fees_cents,
-- tip_cents, total_cents, subtotal_discount_cents and total_discount_cents (A3). It also carries
-- discount_cents = [sum before, sum after] when the combined discount changed, because that is the
-- one discount key lib/activityText.ts reads. subtotal_cents (printed, display-only, nullable) is
-- not logged: the app has no wording for it.
create or replace function public.update_bill(
  p_bill_id uuid,
  p_rows jsonb,
  p_subtotal_cents integer,
  p_tax_cents integer,
  p_fees_cents integer,
  p_tip_cents integer,
  p_subtotal_discount_cents integer,
  p_total_discount_cents integer,
  p_total_cents integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
  v_old public.bills;
  v_amounts jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Host check, and a row lock so two edits of the same bill run one after the other.
  select b.* into v_old
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  v_bill_id := v_old.id;
  if v_bill_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform private.validate_bill_rows(
    p_rows, true, p_subtotal_cents, p_tax_cents, p_fees_cents, p_tip_cents,
    p_subtotal_discount_cents, p_total_discount_cents, p_total_cents
  );

  -- Every id must be one of THIS bill's rows (an id from another bill, or an unknown one, is
  -- rejected before anything changes). The validator already checked ids are unique uuids.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as e
    where e ? 'id'
      and not exists (
        select 1 from public.line_items as li
        where li.id = (e ->> 'id')::uuid and li.bill_id = v_bill_id
      )
  ) then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;

  -- Item events, computed before any row changes (old rows and their claims are still here).
  perform private.log_event(v_bill_id, v_uid, ev.kind, ev.item_name, ev.details)
  from (
    with old_rows as (
      select li.id, li.group_position as gp, li.group_size as gs, li.name as nm, li.note as nt,
             li.total_cents as tc
      from public.line_items as li
      where li.bill_id = v_bill_id
    ),
    old_groups as (
      select r.gp, min(r.nm) as nm, min(r.nt) as nt, max(r.gs) as qty, sum(r.tc)::bigint as price
      from old_rows as r group by r.gp
    ),
    new_rows as (
      select case when e ? 'id' then (e ->> 'id')::uuid end as id,
             (e ->> 'group_position')::integer as gp,
             (e ->> 'group_size')::integer as gs,
             btrim(e ->> 'name') as nm,
             case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end as nt,
             (e ->> 'total_cents')::integer as tc
      from jsonb_array_elements(p_rows) as e
    ),
    new_groups as (
      select r.gp, min(r.nm) as nm, min(r.nt) as nt, max(r.gs) as qty, sum(r.tc)::bigint as price
      from new_rows as r group by r.gp
    ),
    pairs as (
      select distinct o.gp as old_gp, n.gp as new_gp
      from new_rows as n join old_rows as o on o.id = n.id
    ),
    matched as (
      select p.new_gp, min(p.old_gp) as old_gp from pairs as p group by p.new_gp
    )
    -- Added groups.
    select 'item_added'::text as kind, ng.nm as item_name,
           jsonb_build_object('qty', ng.qty, 'price_cents', ng.price) as details,
           1 as sort_group, ng.gp as sort_pos
    from new_groups as ng
    where not exists (select 1 from pairs as p where p.new_gp = ng.gp)
    union all
    -- Removed groups, with who had claims on them.
    select 'item_removed', og.nm,
           jsonb_build_object(
             'qty', og.qty, 'price_cents', og.price,
             'claimer_ids', coalesce((
               select jsonb_agg(distinct c.user_id::text)
               from public.claims as c
               join old_rows as r on r.id = c.line_item_id
               where r.gp = og.gp
             ), '[]'::jsonb)
           ),
           0, og.gp
    from old_groups as og
    where not exists (select 1 from pairs as p where p.old_gp = og.gp)
    union all
    -- Changed groups: only the fields that differ (jsonb_strip_nulls drops the rest).
    select 'item_changed', ch.nm, ch.d, 2, ch.gp
    from (
      select ng.gp, ng.nm,
             jsonb_strip_nulls(jsonb_build_object(
               'name', case when og.nm <> ng.nm then jsonb_build_array(og.nm, ng.nm) end,
               'qty', case when og.qty <> ng.qty then jsonb_build_array(og.qty, ng.qty) end,
               'price_cents', case when og.price <> ng.price then jsonb_build_array(og.price, ng.price) end,
               'note_changed', case when og.nt is distinct from ng.nt then true end
             )) as d
      from matched as m
      join new_groups as ng on ng.gp = m.new_gp
      join old_groups as og on og.gp = m.old_gp
    ) as ch
    where ch.d <> '{}'::jsonb
    order by sort_group, sort_pos
  ) as ev;

  v_amounts := jsonb_strip_nulls(jsonb_build_object(
    'tax_cents', case when v_old.tax_cents <> p_tax_cents
                      then jsonb_build_array(v_old.tax_cents, p_tax_cents) end,
    'fees_cents', case when v_old.fees_cents <> p_fees_cents
                       then jsonb_build_array(v_old.fees_cents, p_fees_cents) end,
    'tip_cents', case when v_old.tip_cents <> p_tip_cents
                      then jsonb_build_array(v_old.tip_cents, p_tip_cents) end,
    'subtotal_discount_cents', case when v_old.subtotal_discount_cents <> p_subtotal_discount_cents
                      then jsonb_build_array(v_old.subtotal_discount_cents, p_subtotal_discount_cents) end,
    'total_discount_cents', case when v_old.total_discount_cents <> p_total_discount_cents
                      then jsonb_build_array(v_old.total_discount_cents, p_total_discount_cents) end,
    'discount_cents', case when v_old.subtotal_discount_cents + v_old.total_discount_cents
                                <> p_subtotal_discount_cents + p_total_discount_cents
                      then jsonb_build_array(v_old.subtotal_discount_cents + v_old.total_discount_cents,
                                             p_subtotal_discount_cents + p_total_discount_cents) end,
    'total_cents', case when v_old.total_cents <> p_total_cents
                        then jsonb_build_array(v_old.total_cents, p_total_cents) end
  ));
  if v_amounts <> '{}'::jsonb then
    perform private.log_event(v_bill_id, v_uid, 'amounts_changed', null, v_amounts);
  end if;

  -- Rows not in the list are removed; their claims cascade (claims_line_item_fkey).
  delete from public.line_items as li
  where li.bill_id = v_bill_id
    and not exists (
      select 1 from jsonb_array_elements(p_rows) as e
      where e ? 'id' and (e ->> 'id')::uuid = li.id
    );

  -- Kept rows: new name, note, group fields and price. line_items_bill_group_unit_key is
  -- deferrable initially deferred, so swapping two groups' positions doesn't collide midway.
  update public.line_items as li
  set group_position = (e ->> 'group_position')::integer,
      unit_index = (e ->> 'unit_index')::integer,
      group_size = (e ->> 'group_size')::integer,
      name = btrim(e ->> 'name'),
      note = case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
      total_cents = (e ->> 'total_cents')::integer
  from jsonb_array_elements(p_rows) as e
  where e ? 'id'
    and li.id = (e ->> 'id')::uuid
    and li.bill_id = v_bill_id;

  -- New rows.
  insert into public.line_items (
    bill_id, group_position, unit_index, group_size, name, note, total_cents
  )
  select v_bill_id,
         (e ->> 'group_position')::integer,
         (e ->> 'unit_index')::integer,
         (e ->> 'group_size')::integer,
         btrim(e ->> 'name'),
         case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
         (e ->> 'total_cents')::integer
  from jsonb_array_elements(p_rows) as e
  where not (e ? 'id');

  -- Money and edited_at. This one update also fires the bills broadcast (no line_items
  -- trigger is needed).
  update public.bills as b
  set subtotal_cents = p_subtotal_cents,
      tax_cents = p_tax_cents,
      fees_cents = p_fees_cents,
      tip_cents = p_tip_cents,
      subtotal_discount_cents = p_subtotal_discount_cents,
      total_discount_cents = p_total_discount_cents,
      total_cents = p_total_cents,
      edited_at = now()
  where b.id = v_bill_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.set_item_split: logs split_changed with the parts before and after
-- ---------------------------------------------------------------------------
-- Body unchanged from 20261121075755 except that it reads the row's name and unit, snapshots the
-- parts before and after the update, and logs split_changed. A call that leaves every part as it
-- was logs nothing (it still records split_set_by/at, as before). A failed call raises before
-- the log, so it logs nothing.
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

-- `create or replace` keeps each function's owner and grants (revoked from public/anon,
-- granted to authenticated in the earlier migrations). Restated here so this file alone shows it.
revoke execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.join_bill(text) from public, anon, authenticated;
revoke execute on function public.rotate_join_code(uuid) from public, anon, authenticated;
revoke execute on function public.update_bill(uuid, jsonb, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.set_item_split(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer, integer)
  to authenticated;
grant execute on function public.join_bill(text) to authenticated;
grant execute on function public.rotate_join_code(uuid) to authenticated;
grant execute on function public.update_bill(uuid, jsonb, integer, integer, integer, integer, integer, integer, integer)
  to authenticated;
grant execute on function public.set_item_split(uuid, jsonb) to authenticated;
