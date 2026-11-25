-- Claimable discounts, Task 2 (spec docs/specs/2026-11-24-claimable-discounts.md, C1 and
-- "Edits after people claimed", criteria 13-17). Earlier migrations are applied and are not
-- edited. public.update_bill is re-created (same signature, so its grants stay) from its latest
-- body in 20261122085802_m2_review_fixes.sql with these changes:
--   * A kept id whose stored kind differs from the row's kind (absent = 'item') raises
--     22023 invalid_bill before anything is logged or written. A row never changes kind in place
--     (CD-11): Claim -> Split drops the row, Split -> Claim adds a new one.
--   * Inserts write kind / applies_to (applies_to only for discount rows). Updates of kept rows
--     write applies_to (a kept discount may move between subtotal and total; kind can't change).
--     Blank notes are stored as null, as before (line_items_kind_shape requires null on
--     discount rows).
--   * item_added / item_removed / item_changed for a discount row carry "discount": true. Item
--     events are unchanged (no discount key). A change to applies_to alone logs nothing (it moves
--     nobody's money; the totals it implies show in amounts_changed if the sums move).
--
-- Lock order: unchanged. update_bill takes FOR UPDATE on the bills row first (host check), then
-- reads line_items / claims without locks (validation, the new kind check, event rows), inserts
-- bill_events (FOR KEY SHARE on the already-locked bills row), deletes dropped line_items (their
-- claims cascade: row locks on line_items, then claims), updates kept rows, inserts new rows, and
-- updates the bills row. The kind check adds a read only, no lock.
--
-- Grants: unchanged (revoked from public/anon, granted to authenticated); restated at the end.

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

  -- A kept row keeps its kind (an absent kind means 'item'). Checked before any event or write.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as e
    join public.line_items as li on li.id = (e ->> 'id')::uuid and li.bill_id = v_bill_id
    where e ? 'id'
      and li.kind <> coalesce(e ->> 'kind', 'item')
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
  -- A group holds rows of one kind (validate_bill_rows for new rows; a stored discount row is a
  -- group of size 1), and a matched pair has the same kind (the check above).
  perform private.log_event(v_bill_id, v_uid, ev.kind, ev.item_name, ev.details)
  from (
    with old_rows as (
      select li.id, li.group_position as gp, li.group_size as gs, li.name as nm, li.note as nt,
             li.total_cents as tc, li.kind as kd
      from public.line_items as li
      where li.bill_id = v_bill_id
    ),
    old_groups as (
      select r.gp, min(r.nm) as nm, min(r.nt) as nt, max(r.gs) as qty, sum(r.tc)::bigint as price,
             bool_or(r.kd = 'discount') as is_discount
      from old_rows as r group by r.gp
    ),
    new_rows as (
      select case when e ? 'id' then (e ->> 'id')::uuid end as id,
             (e ->> 'group_position')::integer as gp,
             (e ->> 'group_size')::integer as gs,
             btrim(e ->> 'name') as nm,
             case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end as nt,
             (e ->> 'total_cents')::integer as tc,
             coalesce(e ->> 'kind', 'item') as kd
      from jsonb_array_elements(p_rows) as e
    ),
    new_groups as (
      select r.gp, min(r.nm) as nm, min(r.nt) as nt, max(r.gs) as qty, sum(r.tc)::bigint as price,
             bool_or(r.kd = 'discount') as is_discount
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
           jsonb_build_object('qty', ng.qty, 'price_cents', ng.price)
             || case when ng.is_discount then '{"discount": true}'::jsonb else '{}'::jsonb end
             as details,
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
           ) || case when og.is_discount then '{"discount": true}'::jsonb else '{}'::jsonb end,
           0, og.gp
    from old_groups as og
    where not exists (select 1 from pairs as p where p.old_gp = og.gp)
    union all
    -- Changed groups: only the fields that differ (jsonb_strip_nulls drops the rest). The
    -- discount flag is added after the "anything changed?" test, so it never logs on its own.
    select 'item_changed', ch.nm,
           ch.d || case when ch.is_discount then '{"discount": true}'::jsonb else '{}'::jsonb end,
           2, ch.gp
    from (
      select ng.gp, ng.nm, ng.is_discount,
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

  -- Kept rows: new name, note, group fields, price and (discount rows) applies_to. kind is not
  -- written: the check above made it equal. line_items_bill_group_unit_key is deferrable
  -- initially deferred, so swapping two groups' positions doesn't collide midway.
  update public.line_items as li
  set group_position = (e ->> 'group_position')::integer,
      unit_index = (e ->> 'unit_index')::integer,
      group_size = (e ->> 'group_size')::integer,
      name = btrim(e ->> 'name'),
      note = case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
      total_cents = (e ->> 'total_cents')::integer,
      applies_to = case when li.kind = 'discount' then e ->> 'applies_to' end
  from jsonb_array_elements(p_rows) as e
  where e ? 'id'
    and li.id = (e ->> 'id')::uuid
    and li.bill_id = v_bill_id;

  -- New rows.
  insert into public.line_items (
    bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to
  )
  select v_bill_id,
         (e ->> 'group_position')::integer,
         (e ->> 'unit_index')::integer,
         (e ->> 'group_size')::integer,
         btrim(e ->> 'name'),
         case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
         (e ->> 'total_cents')::integer,
         coalesce(e ->> 'kind', 'item'),
         case when coalesce(e ->> 'kind', 'item') = 'discount' then e ->> 'applies_to' end
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
