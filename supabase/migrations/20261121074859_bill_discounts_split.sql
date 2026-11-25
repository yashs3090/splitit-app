-- M1b + M2, Task 3 follow-up (coordinator decision 2026-11-21, from Task 7's findings):
-- store subtotal-level and total-level discounts separately.
--
-- A single bills.discount_cents loses whether a discount applied before or after the
-- subtotal, so a reloaded bill could fail the form's "items vs subtotal" check and block the
-- host's edit. discount_cents is dropped (nothing used it yet; the local DB had no bills) and
-- replaced by subtotal_discount_cents and total_discount_cents. The totals validation now runs
-- the same two checks as checkTotals in lib/receiptText.ts instead of one combined check.
--
-- 20261121074604_bill_functions.sql was already applied locally, so this is a new migration
-- (append-only): it drops and recreates validate_bill_rows and create_bill with the new
-- argument lists. join_bill, rotate_join_code and set_claim are unchanged.

alter table public.bills drop column discount_cents;

alter table public.bills
  add column subtotal_discount_cents integer not null default 0
    constraint bills_subtotal_discount_cents_range check (subtotal_discount_cents between 0 and 99999999),
  add column total_discount_cents integer not null default 0
    constraint bills_total_discount_cents_range check (total_discount_cents between 0 and 99999999);

comment on column public.bills.subtotal_discount_cents is
  'Discounts applied before the subtotal (items - this = subtotal). Integer cents.';
comment on column public.bills.total_discount_cents is
  'Discounts applied after the subtotal (subtotal + tax + fees + tip - this = total). Integer cents.';

-- bills had select-only grants (Task 1); column-level grants are not used on bills, so the new
-- columns inherit the table-level SELECT for authenticated and nothing for anon.

drop function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer);
drop function private.validate_bill_rows(jsonb, boolean, integer, integer, integer, integer, integer, integer);

-- ---------------------------------------------------------------------------
-- private.validate_bill_rows (recreated with both discounts)
-- ---------------------------------------------------------------------------
create function private.validate_bill_rows(
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
  v_sum bigint := 0;
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
         where k not in ('id', 'name', 'note', 'group_position', 'unit_index', 'group_size', 'total_cents')
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
       or not private.jsonb_int_between(v_row -> 'group_size', 1, 99)
       or not private.jsonb_int_between(v_row -> 'total_cents', 0, 9999999) then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;

    v_sum := v_sum + (v_row ->> 'total_cents')::bigint;
  end loop;

  -- Group structure. Safe to cast now: every row passed the checks above.
  if exists (
       with r as (
         select (e ->> 'group_position')::integer as gp,
                (e ->> 'unit_index')::integer as ui,
                (e ->> 'group_size')::integer as gs,
                btrim(e ->> 'name') as nm,
                -- Blank notes count as null; '' can't be a stored note, so it stands for null.
                case when btrim(coalesce(e ->> 'note', '')) = '' then '' else e ->> 'note' end as nt
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

  -- The same two checks as totalsGaps/checkTotals in lib/receiptText.ts (tolerance 1 cent
  -- each), so the form and the database never disagree:
  --   with a subtotal:  items - subtotal discounts = subtotal
  --                     subtotal + tax + fees + tip - total discounts = total
  --   without one:      items - all discounts + tax + fees + tip = total
  -- With a subtotal, each check may be 1 cent off on its own (so 1 + 1 cents is accepted).
  v_extras := p_tax_cents::bigint + p_fees_cents + p_tip_cents;
  if p_subtotal_cents is not null then
    if abs(v_sum - p_subtotal_discount_cents - p_subtotal_cents) > 1
       or abs(p_subtotal_cents + v_extras - p_total_discount_cents - p_total_cents) > 1 then
      raise exception using errcode = '22023', message = 'invalid_bill';
    end if;
  elsif abs(v_sum - p_subtotal_discount_cents - p_total_discount_cents + v_extras - p_total_cents) > 1 then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;
end;
$$;

revoke execute on function private.validate_bill_rows(jsonb, boolean, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.create_bill (recreated with both discounts)
-- ---------------------------------------------------------------------------
create function public.create_bill(
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

  bill_id := v_bill_id;
  join_code := v_code;
  return next;
end;
$$;

revoke execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer, integer)
  to authenticated;
