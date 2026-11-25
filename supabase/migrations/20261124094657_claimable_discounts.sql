-- Claimable discounts, Task 1 (spec docs/specs/2026-11-24-claimable-discounts.md, contracts C1
-- and C2, criteria 1-12). Earlier migrations are applied and are not edited.
--
-- A bill-level discount the host marks "Claim like an item" is stored as a line_items row with
-- kind = 'discount', a NEGATIVE total_cents (CD-4) and applies_to = 'subtotal' | 'total'.
-- Participants claim it, and share it by parts, through the unchanged set_claim /
-- set_item_split. Discounts the host leaves as Split stay in bills.subtotal_discount_cents /
-- total_discount_cents, as before.
--
-- What this migration does:
--   * line_items gains kind (default 'item') and applies_to (null). Existing rows become items
--     through the column defaults and satisfy the new check.
--   * line_items_total_cents_range (0..9999999 for every row) is replaced by
--     line_items_kind_shape, which keeps that rule for items and adds the discount shape.
--   * private.validate_bill_rows (same signature) accepts the kind / applies_to keys, requires at
--     least one item row, and runs the C2 totals rule with each discount row counted in its own
--     bucket (I, R_sub, R_tot).
--   * public.create_bill (same signature, body from 20261121080352_bill_events.sql) inserts kind /
--     applies_to, and bill_created.details.items counts ITEM groups only.
--   update_bill is not changed here (Task 2, 20261124094658). Until then it validates with the
--   new rules but inserts every new row as an item, so a new discount row sent to it fails the
--   kind_shape check (23514) and nothing is written.
--
-- Grants: unchanged. line_items keeps table-level SELECT for authenticated (so kind and
-- applies_to are readable by participants through the existing RLS policy) and no client
-- INSERT, UPDATE or DELETE; anon has nothing. No line_items column is hidden from clients, so
-- select('*') on line_items would still work (the app names its columns anyway).
--
-- Lock order: no new lock paths. Claims on discount rows go through the same set_claim /
-- claims_lock_bill_first trigger / set_item_split paths as items (bills row first, per
-- 20261124094656_people_review_fixes.sql). set_claim, set_item_split and create_bill lock
-- exactly what they locked before: create_bill still inserts the new bills row, then its
-- line_items (FOR KEY SHARE on that bills row through line_items_bill_id_fkey), then the host's
-- bill_participants row, then the bill_created event. ALTER TABLE below takes an ACCESS
-- EXCLUSIVE lock on line_items for the length of the migration only.

-- ---------------------------------------------------------------------------
-- C1: columns and constraints
-- ---------------------------------------------------------------------------
alter table public.line_items
  add column kind text not null default 'item'
    constraint line_items_kind_known check (kind in ('item', 'discount')),
  add column applies_to text null;

alter table public.line_items drop constraint line_items_total_cents_range;

alter table public.line_items
  add constraint line_items_kind_shape check (
    (
      kind = 'item'
      and applies_to is null
      and total_cents between 0 and 9999999
    )
    or (
      kind = 'discount'
      and applies_to is not null
      and applies_to in ('subtotal', 'total')
      and total_cents between -9999999 and -1
      and group_size = 1
      and unit_index = 0
      and note is null
    )
  );

comment on column public.line_items.kind is
  'item (default) or discount. A discount row is a claimable bill-level discount (ADR 0017).';
comment on column public.line_items.applies_to is
  'Discount rows only: subtotal (before the subtotal) or total (after it). Null for items.';
comment on column public.line_items.total_cents is
  'This unit''s price in integer cents: 0..9999999 for items, -9999999..-1 (stored negative) '
  'for discount rows.';

-- ---------------------------------------------------------------------------
-- private.validate_bill_rows (same signature; C1 row keys, >= 1 item row, C2 totals)
-- ---------------------------------------------------------------------------
-- security invoker: it reads no tables, it only inspects its arguments. Any failure raises
-- 22023 'invalid_bill'. Row rules (C1):
--   * 1-500 rows; each an object with only the keys id?, name, note, group_position, unit_index,
--     group_size, total_cents, kind?, applies_to?; every number a JSON integer.
--   * kind: absent = 'item'; if present, the JSON string "item" or "discount".
--   * item rows: applies_to absent or JSON null; total_cents 0..9999999 (unchanged).
--   * discount rows: applies_to the JSON string "subtotal" or "total"; total_cents -9999999..-1;
--     group_size 1 and unit_index 0; note absent, null or blank.
--   * at least one item row.
--   * group positions are shared by items and discounts (0..G-1 contiguous); a group holds rows
--     of one kind only.
create or replace function private.validate_bill_rows(
  p_rows jsonb,
  p_allow_ids boolean,
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
immutable
set search_path = ''
as $$
declare
  v_row jsonb;
  v_note text;
  v_kind text;
  v_applies text;
  v_items bigint := 0;        -- I: sum of item rows
  v_r_sub bigint := 0;        -- R_sub: sum of -total_cents of 'subtotal' discount rows
  v_r_tot bigint := 0;        -- R_tot: the same for 'total' discount rows
  v_item_rows integer := 0;
  v_dsub bigint;
  v_dtot bigint;
  v_extras bigint;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;

  for v_row in select e.value from jsonb_array_elements(p_rows) as e loop
    if jsonb_typeof(v_row) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(v_row) as k
         where k not in ('id', 'name', 'note', 'group_position', 'unit_index', 'group_size',
                         'total_cents', 'kind', 'applies_to')
       ) then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    if v_row ? 'id' and (
         not coalesce(p_allow_ids, false)
         or jsonb_typeof(v_row -> 'id') <> 'string'
         or (v_row ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ) then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    if jsonb_typeof(v_row -> 'name') is distinct from 'string'
       or char_length(btrim(v_row ->> 'name')) not between 1 and 100 then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    if v_row ? 'note' and jsonb_typeof(v_row -> 'note') not in ('null', 'string') then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;
    v_note := v_row ->> 'note';
    if v_note is not null and btrim(v_note) <> '' and char_length(v_note) > 200 then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    if not private.jsonb_int_between(v_row -> 'group_position', 0, 499)
       or not private.jsonb_int_between(v_row -> 'unit_index', 0, 98)
       or not private.jsonb_int_between(v_row -> 'group_size', 1, 99) then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    -- kind: absent means 'item'; present must be the JSON string "item" or "discount".
    if not (v_row ? 'kind') then
      v_kind := 'item';
    elsif jsonb_typeof(v_row -> 'kind') = 'string'
          and (v_row ->> 'kind') in ('item', 'discount') then
      v_kind := v_row ->> 'kind';
    else
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    if v_kind = 'item' then
      if (v_row ? 'applies_to' and jsonb_typeof(v_row -> 'applies_to') <> 'null')
         or not private.jsonb_int_between(v_row -> 'total_cents', 0, 9999999) then
        raise exception using errcode = '22023', message = 'invalid_bill';
      end if;
      v_items := v_items + (v_row ->> 'total_cents')::bigint;
      v_item_rows := v_item_rows + 1;
    else
      if jsonb_typeof(v_row -> 'applies_to') is distinct from 'string'
         or (v_row ->> 'applies_to') not in ('subtotal', 'total')
         or not private.jsonb_int_between(v_row -> 'total_cents', -9999999, -1)
         or (v_row ->> 'group_size')::integer <> 1
         or (v_row ->> 'unit_index')::integer <> 0
         or (v_note is not null and btrim(v_note) <> '') then
        raise exception using errcode = '22023', message = 'invalid_bill';
      end if;
      v_applies := v_row ->> 'applies_to';
      if v_applies = 'subtotal' then
        v_r_sub := v_r_sub - (v_row ->> 'total_cents')::bigint;
      else
        v_r_tot := v_r_tot - (v_row ->> 'total_cents')::bigint;
      end if;
    end if;
  end loop;

  -- A bill must have at least one item row (rows that are all discounts are invalid).
  if v_item_rows = 0 then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;

  -- Group structure. Safe to cast now: every row passed the checks above. A group holds rows of
  -- one kind only (a discount row is always a group of size 1, so this only restates it).
  if exists (
       with r as (
         select (e ->> 'group_position')::integer as gp,
                (e ->> 'unit_index')::integer as ui,
                (e ->> 'group_size')::integer as gs,
                btrim(e ->> 'name') as nm,
                -- Blank notes count as null; '' can't be a stored note, so it stands for null.
                case when btrim(coalesce(e ->> 'note', '')) = '' then '' else e ->> 'note' end as nt,
                coalesce(e ->> 'kind', 'item') as kd
         from jsonb_array_elements(p_rows) as e
       )
       select 1 from r
       group by r.gp
       having count(*) <> min(r.gs)
           or min(r.gs) <> max(r.gs)
           or count(distinct r.ui) <> count(*)
           or min(r.ui) <> 0
           or max(r.ui) <> count(*) - 1
           or count(distinct r.nm) <> 1
           or count(distinct r.nt) <> 1
           or count(distinct r.kd) <> 1
     )
     or exists (
       select 1
       from jsonb_array_elements(p_rows) as e
       having min((e ->> 'group_position')::integer) <> 0
           or max((e ->> 'group_position')::integer)
              <> count(distinct (e ->> 'group_position')::integer) - 1
     )
     or exists (
       select 1
       from jsonb_array_elements(p_rows) as e
       where e ? 'id'
       group by lower(e ->> 'id')
       having count(*) > 1
     ) then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;

  -- Money: every argument non-null and in range (subtotal may be null).
  if (p_subtotal_cents is not null and p_subtotal_cents not between 0 and 99999999)
     or p_tax_cents is null or p_tax_cents not between 0 and 99999999
     or p_fees_cents is null or p_fees_cents not between 0 and 99999999
     or p_tip_cents is null or p_tip_cents not between 0 and 99999999
     or p_subtotal_discount_cents is null or p_subtotal_discount_cents not between 0 and 99999999
     or p_total_discount_cents is null or p_total_discount_cents not between 0 and 99999999
     or p_total_cents is null or p_total_cents not between 0 and 99999999 then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;

  -- C2: the same two checks as totalsGaps/checkTotals in lib/receiptText.ts (tolerance 1 cent
  -- each), with each discount row counted in its own bucket:
  --   Dsub = p_subtotal_discount_cents + R_sub,  Dtot = p_total_discount_cents + R_tot,
  --   X = tax + fees + tip.
  --   with a subtotal:  |I - Dsub - S| <= 1  and  |S + X - Dtot - T| <= 1
  --   without one:      |I - Dsub - Dtot + X - T| <= 1
  -- With no discount rows this is exactly the previous rule.
  v_dsub := p_subtotal_discount_cents::bigint + v_r_sub;
  v_dtot := p_total_discount_cents::bigint + v_r_tot;
  v_extras := p_tax_cents::bigint + p_fees_cents + p_tip_cents;
  if p_subtotal_cents is not null then
    if abs(v_items - v_dsub - p_subtotal_cents) > 1
       or abs(p_subtotal_cents + v_extras - v_dtot - p_total_cents) > 1 then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;
  elsif abs(v_items - v_dsub - v_dtot + v_extras - p_total_cents) > 1 then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.create_bill (same signature; body from 20261121080352_bill_events.sql)
-- ---------------------------------------------------------------------------
-- Changes: inserts kind / applies_to (kind defaults to 'item'; a blank discount note is stored
-- as null, which the kind_shape check requires), and bill_created.details.items counts item
-- groups only (discount rows are not form items).
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
  from jsonb_array_elements(p_rows) as e;

  insert into public.bill_participants (bill_id, user_id) values (v_bill_id, v_uid);

  -- "items" counts form items (groups) of kind 'item', not unit rows (Beer x2 is one item) and
  -- not discount rows.
  perform private.log_event(
    v_bill_id, v_uid, 'bill_created', null,
    jsonb_build_object(
      'items', (select count(distinct (e ->> 'group_position')::integer)
                from jsonb_array_elements(p_rows) as e
                where coalesce(e ->> 'kind', 'item') = 'item'),
      'total_cents', p_total_cents
    )
  );

  bill_id := v_bill_id;
  join_code := v_code;
  return next;
end;
$$;

-- `create or replace` keeps each function's owner and grants. Restated so this file alone shows
-- them: validate_bill_rows is internal (no client role), create_bill is for authenticated only.
revoke execute on function private.validate_bill_rows(jsonb, boolean, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer, integer)
  to authenticated;
