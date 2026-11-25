-- M1b + M2, Task 3: shared row validation, create_bill, join_bill, rotate_join_code, set_claim.
-- Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Functions and Realtime", design
-- decisions 1-5, criteria 22-34). Builds on 20261121074115_bills_claims.sql (not edited).
--
-- These SQL functions are the only write paths for bills, line_items and bill_participants
-- (ADR 0013, approved in A1.4). They run inside the managed Supabase Postgres; no server
-- program and no secret are involved.
--
-- Error contract (the app maps only SQLSTATE + these fixed messages):
--   42501 'not_allowed'   no signed-in user, or not the host / no such bill
--   22023 'invalid_bill'  rows or money failed validation
--   22023 'invalid_claim' set_claim called with a null p_claimed
--   P0002 'invalid_code'  join code malformed or unknown (same error for both)
--   P0002 'not_found'     set_claim on a row that doesn't exist or isn't visible to the caller

-- ---------------------------------------------------------------------------
-- private.jsonb_int_between: true iff v is a JSON integer (not 12.5, not "12") in [lo, hi].
-- ---------------------------------------------------------------------------
-- CASE guarantees the regex runs before the cast, so bad input returns false instead of
-- raising a cast error. jsonb normalises 1e3 to 1000, which is an integer and is accepted.
create function private.jsonb_int_between(v jsonb, lo bigint, hi bigint)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when v is null or jsonb_typeof(v) <> 'number' then false
    when v::text !~ '^-?[0-9]{1,12}$' then false
    else v::text::bigint between lo and hi
  end;
$$;

-- ---------------------------------------------------------------------------
-- private.validate_bill_rows: shared validation for create_bill and update_bill (Task 4).
-- ---------------------------------------------------------------------------
-- security invoker (the default): it reads no tables, it only inspects its arguments.
-- Any failure raises 22023 'invalid_bill'. Rules (spec "Shared row validation"):
--   * 1-500 rows; each an object with only the keys id?, name, note, group_position,
--     unit_index, group_size, total_cents; every number a JSON integer.
--   * id only when p_allow_ids (update_bill), and then a uuid string, unique in the list.
--   * name: string, 1-100 chars after trimming. note: null/absent or a string; a blank note
--     counts as null; at most 200 chars.
--   * group_position contiguous 0..G-1; within a group unit_index is exactly 0..size-1 once
--     each, and name, note and group_size are the same on every row; group_size = row count.
--   * money: non-null and 0..99999999 (subtotal may be null);
--     abs(total - (sum of rows - discount + tax + fees + tip)) <= 1.
create function private.validate_bill_rows(
  p_rows jsonb,
  p_allow_ids boolean,
  p_subtotal_cents integer,
  p_tax_cents integer,
  p_fees_cents integer,
  p_tip_cents integer,
  p_discount_cents integer,
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

  -- Money.
  if (p_subtotal_cents is not null and p_subtotal_cents not between 0 and 99999999)
     or p_tax_cents is null or p_tax_cents not between 0 and 99999999
     or p_fees_cents is null or p_fees_cents not between 0 and 99999999
     or p_tip_cents is null or p_tip_cents not between 0 and 99999999
     or p_discount_cents is null or p_discount_cents not between 0 and 99999999
     or p_total_cents is null or p_total_cents not between 0 and 99999999
     or abs(p_total_cents::bigint
            - (v_sum - p_discount_cents + p_tax_cents + p_fees_cents + p_tip_cents)) > 1 then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;
end;
$$;

-- Internal helpers: only the security definer functions below (owned by postgres) call them.
revoke execute on function private.jsonb_int_between(jsonb, bigint, bigint) from public, anon, authenticated;
revoke execute on function private.validate_bill_rows(jsonb, boolean, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.create_bill
-- ---------------------------------------------------------------------------
-- security definer: clients have no insert grant on bills, line_items or bill_participants
-- (Task 1), and the bill, its rows and the host participant must be one transaction.
-- It limits itself: host_id is always auth.uid() (there is no host parameter), the join code
-- is generated here (design decision 1), and rows may not carry ids.
-- Returns one row (bill_id, join_code); supabase-js rpc() gives it as a one-element array.
create function public.create_bill(
  p_rows jsonb,
  p_subtotal_cents integer,
  p_tax_cents integer,
  p_fees_cents integer,
  p_tip_cents integer,
  p_discount_cents integer,
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
    p_discount_cents, p_total_cents
  );

  -- 80 random bits as 20 lowercase hex chars. Retry (up to 3 attempts) on a code collision.
  loop
    v_attempt := v_attempt + 1;
    v_code := encode(extensions.gen_random_bytes(10), 'hex');
    begin
      insert into public.bills as b (
        host_id, subtotal_cents, tax_cents, fees_cents, tip_cents, discount_cents,
        total_cents, join_code
      ) values (
        v_uid, p_subtotal_cents, p_tax_cents, p_fees_cents, p_tip_cents, p_discount_cents,
        p_total_cents, v_code
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

-- ---------------------------------------------------------------------------
-- public.join_bill
-- ---------------------------------------------------------------------------
-- security definer: the caller is not a participant yet, so RLS hides the bill from them,
-- and there is no client insert on bill_participants (design decision 3). It only ever adds
-- the caller themself. Malformed and unknown codes give the same error, so the response
-- doesn't tell a guesser whether a code is well formed. Returns the bill id.
create function public.join_bill(p_code text)
returns uuid
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

  return v_bill_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.rotate_join_code
-- ---------------------------------------------------------------------------
-- security definer: clients have no update grant on bills. Host only; "not the host" and
-- "no such bill" give the same error. Participants already in the bill stay in. Returns the
-- new code.
create function public.rotate_join_code(p_bill_id uuid)
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

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.set_claim
-- ---------------------------------------------------------------------------
-- security INVOKER: claiming yourself is an ordinary insert/delete that RLS and the column
-- grants already allow, so the function runs as the caller and all of that still applies
-- (design decision 2). It never touches anyone else's claim or parts (A2.3).
create function public.set_claim(p_line_item_id uuid, p_claimed boolean)
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
    insert into public.claims (bill_id, line_item_id, user_id)
    values (v_bill_id, p_line_item_id, v_uid)
    on conflict (line_item_id, user_id) do nothing;
  else
    delete from public.claims as c
    where c.line_item_id = p_line_item_id and c.user_id = v_uid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants: new functions are executable by PUBLIC by default. Remove that, then allow
-- only signed-in users. anon calls fail with 42501 (permission denied for function).
-- ---------------------------------------------------------------------------
revoke execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.join_bill(text) from public, anon, authenticated;
revoke execute on function public.rotate_join_code(uuid) from public, anon, authenticated;
revoke execute on function public.set_claim(uuid, boolean) from public, anon, authenticated;

grant execute on function public.create_bill(jsonb, integer, integer, integer, integer, integer, integer)
  to authenticated;
grant execute on function public.join_bill(text) to authenticated;
grant execute on function public.rotate_join_code(uuid) to authenticated;
grant execute on function public.set_claim(uuid, boolean) to authenticated;
