-- M2 database review fixes (spec docs/specs/2026-11-20-m1b-m2-share-and-claim.md, A1-A3).
-- Earlier migrations are applied and are not edited; everything is changed here.
--
--   R1  update_bill's amounts_changed no longer writes a combined discount_cents key. It carries
--       subtotal_discount_cents and total_discount_cents only (A3), which is what
--       lib/activityText.ts reads; the extra key made Activity show one discount change twice.
--       (activityText still understands discount_cents, for events logged before this migration.)
--   R2  private.bill_events_append_only is security definer (owner postgres), so "is the bill /
--       profile gone" is judged on the real tables, not through the caller's RLS view.
--   R3  service_role loses INSERT, UPDATE, DELETE and TRUNCATE on bill_events. Foreign-key cascades
--       (bill delete, account delete) run as the table owner, so they keep working.
--   R4  update_bill rejects a new group whose kept row ids come from more than one old group
--       (22023 invalid_bill). The app's form never does this: each draft row keeps only the ids
--       of the one saved group it was loaded from (lib/billPayload.ts toBillArgs / keepIds).
--   R5  (approved by the user 2026-11-22, relayed by the coordinator) when an edit drops claimed
--       units of a kept group, its item_changed event carries
--       removed_claimer_ids: [uid, ...] (distinct users whose claims on the dropped units were
--       removed, sorted). The key is left out when no claimed unit was dropped.
--   R6  set_claim turns a foreign_key_violation (the row was deleted by a concurrent edit between
--       its read and its insert) into P0002 not_found, the same error as a missing row.
--   R7  authenticated reads profiles through a column grant on (id, display_name) only, so
--       co-participants (and the owner, through the Data API) see the display name and nothing
--       else. The app only embeds display_name.
--   R8  the two permissive SELECT policies on profiles become one (own row or a shared bill).
--
-- item_changed details are now: any of { name: [b, a], qty: [b, a], price_cents: [b, a],
-- note_changed: true, removed_claimer_ids: [uid, ...] }.
-- amounts_changed details are now: any of { tax_cents | fees_cents | tip_cents | total_cents |
-- subtotal_discount_cents | total_discount_cents : [b, a] }.

-- ---------------------------------------------------------------------------
-- R2: append-only guard as security definer
-- ---------------------------------------------------------------------------
-- The function only reads public.bills / public.profiles to decide whether a foreign-key action
-- is allowed, and raises otherwise. It takes no arguments and cannot be called directly (trigger
-- functions can only run as triggers; execute is revoked anyway).
alter function private.bill_events_append_only() security definer;
alter function private.bill_events_append_only() owner to postgres;
alter function private.bill_events_append_only() set search_path = '';
revoke execute on function private.bill_events_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- R3: no client or server role writes bill_events directly
-- ---------------------------------------------------------------------------
-- Only private.log_event (security definer, owner postgres) inserts. service_role keeps SELECT
-- (and its default REFERENCES / TRIGGER, which grant no write).
revoke insert, update, delete, truncate on public.bill_events from service_role;

-- ---------------------------------------------------------------------------
-- R7: profiles readable by column (id, display_name) only
-- ---------------------------------------------------------------------------
-- id is needed for RLS, joins/embeds (bill_participants -> profiles) and the own-row update's
-- where clause. created_at and updated_at are no longer client-readable.
revoke select on public.profiles from authenticated;
grant select (id, display_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- R8: one SELECT policy on profiles
-- ---------------------------------------------------------------------------
drop policy "profiles_select_own" on public.profiles;
drop policy "profiles_select_co_participant" on public.profiles;

create policy "profiles_select_own_or_co_participant"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()) or private.shares_bill_with(id));

-- ---------------------------------------------------------------------------
-- R6: public.set_claim (body unchanged from 20261121074604 except the insert's handler)
-- ---------------------------------------------------------------------------
-- security INVOKER, as before: claiming yourself is an ordinary insert/delete that RLS and the
-- column grants already allow.
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

  if p_claimed then
    begin
      insert into public.claims (bill_id, line_item_id, user_id)
      values (v_bill_id, p_line_item_id, v_uid)
      on conflict (line_item_id, user_id) do nothing;
    exception when foreign_key_violation then
      -- The row (or the caller's participant row) was deleted after the read above, e.g. by the
      -- host's concurrent update_bill. To the caller that is the same as a missing row.
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
-- R1, R4, R5: public.update_bill (body from 20261121080352 with those three changes)
-- ---------------------------------------------------------------------------
-- Group matching: a new group is matched to the old group its kept row ids come from. Kept ids
-- from several old groups in one new group are rejected (R4), so each new group has at most one
-- old group. A new group with no kept ids is item_added. An old group none of whose ids are kept
-- is item_removed, with the users who had claims on any of its units (those claims cascade; the
-- claims trigger skips cascades, so no unclaimed events). A matched pair logs item_changed with
-- only the fields that differ: name (trimmed), qty (group size), price_cents (sum of unit prices),
-- note_changed, and removed_claimer_ids when units with claims were dropped (R5). Reordering
-- alone logs nothing. subtotal_cents (printed, display-only, nullable) is not logged.
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

  -- R4: a new group may keep ids from one old group only (no merging two items into one).
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as e
    join public.line_items as li on li.id = (e ->> 'id')::uuid and li.bill_id = v_bill_id
    where e ? 'id'
    group by (e ->> 'group_position')::integer
    having count(distinct li.group_position) > 1
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
    -- One old group per new group (guaranteed by the R4 check above).
    matched as (
      select p.new_gp, min(p.old_gp) as old_gp from pairs as p group by p.new_gp
    ),
    -- Old rows whose ids are not in p_rows: they are deleted below, with their claims.
    dropped_rows as (
      select r.id, r.gp from old_rows as r
      where not exists (select 1 from new_rows as n where n.id = r.id)
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
               'note_changed', case when og.nt is distinct from ng.nt then true end,
               -- R5: null (so left out) when no dropped unit had a claim.
               'removed_claimer_ids', (
                 select jsonb_agg(distinct c.user_id::text order by c.user_id::text)
                 from public.claims as c
                 join dropped_rows as d on d.id = c.line_item_id
                 where d.gp = og.gp
               )
             )) as d
      from matched as m
      join new_groups as ng on ng.gp = m.new_gp
      join old_groups as og on og.gp = m.old_gp
    ) as ch
    where ch.d <> '{}'::jsonb
    order by sort_group, sort_pos
  ) as ev;

  -- R1: the two A3 discount keys only, no combined discount_cents.
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

revoke execute on function public.update_bill(uuid, jsonb, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.update_bill(uuid, jsonb, integer, integer, integer, integer, integer, integer, integer)
  to authenticated;
