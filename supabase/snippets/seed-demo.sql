-- Demo data for the LOCAL database only: fills the signed-in user's Home with one bill per case
-- (hosting, ready, partly paid, differences, settled, guest bills, settle early, who paid) and two
-- groups, so every screen state can be looked at. Never run this against a hosted project.
--
-- Run (from the repo root, local Supabase running):
--   docker exec -i supabase_db_splitit-app psql -U postgres -v ON_ERROR_STOP=1 < supabase/snippets/seed-demo.sql
-- Remove the demo data only (keeps Tejesh, Priya and Arjun, who are on one of the user's own bills):
--   docker exec -i supabase_db_splitit-app psql -U postgres -v ON_ERROR_STOP=1 -v remove=1 < supabase/snippets/seed-demo.sql
--
-- What is "demo data" (the only rows this script deletes):
--   - bills whose join_code starts with 'de0de0' (every bill made here gets that prefix; codes
--     from create_bill are random, so no real bill can be mistaken for one unless it was made here);
--   - groups whose id starts with 'de0000a0-', with their expenses and payments;
--   - with -v remove=1, also the demo users de000000-…-000000000004 to …0009 this script adds.
--
-- How it writes: everything goes through the app's own functions (create_bill, join_bill,
-- set_claim, set_item_split, set_extras_split, add_participant, mark_paid, mark_not_received,
-- set_payer, set_payers, update_bill, mark_bill_seen, create_group, join_group,
-- attach_bill_to_group, add_expense, record_payment, undo_payment, set_not_part), called as the
-- acting user (role authenticated + request.jwt.claims), so RLS, triggers and events stay real.
-- Direct writes, as postgres, only where no function exists:
--   - demo users (auth.users + profiles), as the existing demo users were made;
--   - the 'de0de0' join_code tag on each demo bill;
--   - timestamps: every step runs "now", then pg_temp.stamp moves that step's fresh rows to the
--     step's date (session_replication_role = replica, so the append-only and broadcast triggers
--     don't fire for these timestamp-only updates);
--   - joined_at of demo bills dated before 2026-11-21 13:40 IST is moved just after it (see the
--     end of the script), so Home's 20-bill limit (my_bills) drops the user's two oldest test
--     bills rather than demo bills. joined_at only orders Home; the row's date is created_at.
-- One transaction: any error rolls everything back.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------------------------------------
-- Clean out earlier demo rows (order matters: restrict FKs on group members, bills on groups).
-- ---------------------------------------------------------------------------------------------
delete from public.group_payments where group_id::text like 'de0000a0-%';
delete from public.expenses where group_id::text like 'de0000a0-%';
delete from public.bills where join_code like 'de0de0%';
delete from public.groups where id::text like 'de0000a0-%';

\if :{?remove}
delete from auth.users where id in (
  'de000000-0000-0000-0000-000000000004', 'de000000-0000-0000-0000-000000000005',
  'de000000-0000-0000-0000-000000000006', 'de000000-0000-0000-0000-000000000007',
  'de000000-0000-0000-0000-000000000008', 'de000000-0000-0000-0000-000000000009');
commit;
\echo 'Demo data removed.'
\quit
\endif

-- ---------------------------------------------------------------------------------------------
-- Demo users (they can't sign in). Same shape as the existing three: auth.users + profiles.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values
  ('de000000-0000-0000-0000-000000000004', 'demo-sam@demo.local',  '{"full_name": "Sam (demo)"}'),
  ('de000000-0000-0000-0000-000000000005', 'demo-dee@demo.local',  '{"full_name": "Dee (demo)"}'),
  ('de000000-0000-0000-0000-000000000006', 'demo-maya@demo.local', '{"full_name": "Maya (demo)"}'),
  ('de000000-0000-0000-0000-000000000007', 'demo-leo@demo.local',  '{"full_name": "Leo (demo)"}'),
  ('de000000-0000-0000-0000-000000000008', 'demo-nina@demo.local', '{"full_name": "Nina (demo)"}'),
  ('de000000-0000-0000-0000-000000000009', 'demo-omar@demo.local', '{"full_name": "Omar (demo)"}')
on conflict (id) do nothing;

insert into public.profiles (id, display_name, venmo_username, venmo_prompt_dismissed_at)
values
  ('de000000-0000-0000-0000-000000000004', 'Sam (demo)',  'demo-sam-x',  now()),
  ('de000000-0000-0000-0000-000000000005', 'Dee (demo)',  'demo-dee-x',  now()),
  ('de000000-0000-0000-0000-000000000006', 'Maya (demo)', 'demo-maya-x', now()),
  ('de000000-0000-0000-0000-000000000007', 'Leo (demo)',  'demo-leo-x',  now()),
  ('de000000-0000-0000-0000-000000000008', 'Nina (demo)', 'demo-nina-x', now()),
  ('de000000-0000-0000-0000-000000000009', 'Omar (demo)', 'demo-omar-x', now())
on conflict (id) do update
  set display_name = excluded.display_name, venmo_username = excluded.venmo_username;

-- ---------------------------------------------------------------------------------------------
-- Helpers (session-only, in pg_temp). Each leaves the role as postgres when it returns.
-- ---------------------------------------------------------------------------------------------

-- Who's who: U is the user's real account; the rest are demo users.
create function pg_temp.u(p text) returns uuid language sql immutable as $f$
  select case p
    when 'U' then 'f4fdc161-5a68-4ae5-b935-30b464fd2809'
    when 'T' then 'de000000-0000-0000-0000-000000000001' -- Tejesh
    when 'P' then 'de000000-0000-0000-0000-000000000002' -- Priya
    when 'A' then 'de000000-0000-0000-0000-000000000003' -- Arjun
    when 'S' then 'de000000-0000-0000-0000-000000000004' -- Sam
    when 'D' then 'de000000-0000-0000-0000-000000000005' -- Dee
    when 'M' then 'de000000-0000-0000-0000-000000000006' -- Maya
    when 'L' then 'de000000-0000-0000-0000-000000000007' -- Leo
    when 'N' then 'de000000-0000-0000-0000-000000000008' -- Nina
    when 'O' then 'de000000-0000-0000-0000-000000000009' -- Omar
  end::uuid
$f$;

-- Act as a user: what PostgREST does for a signed-in request.
create function pg_temp.as_user(p text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.u(p), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;

-- Move every row of bill p_bill written since the transaction started to p_at.
create function pg_temp.stamp(p_bill uuid, p_at timestamptz) returns void language plpgsql as $f$
declare t0 timestamptz := now();
begin
  reset role;
  if p_at >= t0 then
    raise exception 'stamp % is not in the past', p_at;
  end if;
  set local session_replication_role = replica;
  update public.bills set created_at = p_at where id = p_bill and created_at >= t0;
  update public.bills set edited_at = p_at where id = p_bill and edited_at >= t0;
  update public.bill_participants set joined_at = p_at where bill_id = p_bill and joined_at >= t0;
  update public.claims set created_at = p_at where bill_id = p_bill and created_at >= t0;
  update public.claims set updated_at = p_at where bill_id = p_bill and updated_at >= t0;
  update public.line_items set split_set_at = p_at where bill_id = p_bill and split_set_at >= t0;
  update public.bill_events set created_at = p_at where bill_id = p_bill and created_at >= t0;
  update public.bill_payments set recorded_at = p_at where bill_id = p_bill and recorded_at >= t0;
  update public.bill_seen set seen_at = p_at where bill_id = p_bill and seen_at >= t0;
  update public.bill_not_part set created_at = p_at where bill_id = p_bill and created_at >= t0;
  set local session_replication_role = origin;
end $f$;

-- The same for a group's own rows.
create function pg_temp.gstamp(p_group uuid, p_at timestamptz) returns void language plpgsql as $f$
declare t0 timestamptz := now();
begin
  reset role;
  if p_at >= t0 then
    raise exception 'gstamp % is not in the past', p_at;
  end if;
  set local session_replication_role = replica;
  update public.groups set created_at = p_at where id = p_group and created_at >= t0;
  update public.group_members set joined_at = p_at where group_id = p_group and joined_at >= t0;
  update public.group_events set created_at = p_at where group_id = p_group and created_at >= t0;
  update public.expenses set created_at = p_at where group_id = p_group and created_at >= t0;
  update public.expenses set edited_at = p_at where group_id = p_group and edited_at >= t0;
  update public.group_payments set created_at = p_at where group_id = p_group and created_at >= t0;
  update public.group_payments set undone_at = p_at where group_id = p_group and undone_at >= t0;
  set local session_replication_role = origin;
end $f$;

-- Rows spec → create_bill's p_rows. Spec: [[name, qty, unit_cents], ...] for items and
-- [name, -cents, 'subtotal'|'total'] for a claimable discount row. p_note goes on group 0 (all
-- units), so the bill screen says which demo case this is.
create function pg_temp.rows_of(p_spec jsonb, p_note text, p_first_gp integer default 0)
returns jsonb language plpgsql as $f$
declare
  v_out jsonb := '[]';
  v_e jsonb;
  v_gp integer := p_first_gp;
  v_i integer;
begin
  for v_e in select e from jsonb_array_elements(p_spec) as e loop
    if (v_e ->> 1)::integer < 0 then
      v_out := v_out || jsonb_build_object('name', v_e ->> 0, 'group_position', v_gp, 'unit_index', 0,
        'group_size', 1, 'total_cents', (v_e ->> 1)::integer, 'kind', 'discount',
        'applies_to', v_e ->> 2);
    else
      for v_i in 0 .. (v_e ->> 1)::integer - 1 loop
        v_out := v_out || (jsonb_build_object('name', v_e ->> 0, 'group_position', v_gp,
          'unit_index', v_i, 'group_size', (v_e ->> 1)::integer, 'total_cents', (v_e ->> 2)::integer)
          || case when v_gp = 0 and p_note is not null then jsonb_build_object('note', p_note)
                  else '{}' end);
      end loop;
    end if;
    v_gp := v_gp + 1;
  end loop;
  return v_out;
end $f$;

-- Subtotal and total that pass the totals check exactly (no tolerance used):
-- subtotal = items − subtotal discount rows; total = subtotal + tax + fees + tip − total discount rows.
create function pg_temp.money_of(p_rows jsonb, p_tax integer, p_fees integer, p_tip integer,
  out subtotal integer, out total integer) language sql immutable as $f$
  select (sum(case when coalesce(e ->> 'kind', 'item') = 'item' then (e ->> 'total_cents')::integer else 0 end)
          + sum(case when e ->> 'applies_to' = 'subtotal' then (e ->> 'total_cents')::integer else 0 end))::integer,
         (sum(case when coalesce(e ->> 'kind', 'item') = 'item' then (e ->> 'total_cents')::integer else 0 end)
          + sum(case when e ->> 'applies_to' is not null then (e ->> 'total_cents')::integer else 0 end)
          + p_tax + p_fees + p_tip)::integer
  from jsonb_array_elements(p_rows) as e
$f$;

-- create_bill as the host, tagged as demo, dated p_at.
create function pg_temp.bill(p_host text, p_spec jsonb, p_tax integer, p_fees integer,
  p_tip integer, p_at timestamptz, p_note text) returns uuid language plpgsql as $f$
declare
  v_rows jsonb := pg_temp.rows_of(p_spec, p_note);
  v_m record;
  v_id uuid;
begin
  select * into v_m from pg_temp.money_of(v_rows, p_tax, p_fees, p_tip);
  perform pg_temp.as_user(p_host);
  select c.bill_id into v_id
  from public.create_bill(v_rows, v_m.subtotal, p_tax, p_fees, p_tip, 0, 0, v_m.total) as c;
  reset role;
  set local session_replication_role = replica;
  update public.bills set join_code = 'de0de0' || encode(extensions.gen_random_bytes(7), 'hex')
  where id = v_id;
  set local session_replication_role = origin;
  perform pg_temp.stamp(v_id, p_at);
  return v_id;
end $f$;

-- update_bill as the host: reprice kept rows ([[gp, ui, cents], ...]), append new groups (rows
-- spec), and set a new tax. Fees and tip stay. Every kept row keeps its id, so claims stay.
create function pg_temp.edit(p_bill uuid, p_price jsonb, p_add jsonb, p_tax integer, p_at timestamptz)
returns void language plpgsql as $f$
declare
  v_b public.bills;
  v_rows jsonb;
  v_next integer;
  v_m record;
begin
  reset role;
  select * into v_b from public.bills where id = p_bill;
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', li.id, 'name', li.name, 'note', li.note, 'group_position', li.group_position,
           'unit_index', li.unit_index, 'group_size', li.group_size,
           'total_cents', coalesce((select (p ->> 2)::integer from jsonb_array_elements(p_price) as p
                                    where (p ->> 0)::integer = li.group_position
                                      and (p ->> 1)::integer = li.unit_index), li.total_cents),
           'kind', li.kind, 'applies_to', li.applies_to))
         order by li.group_position, li.unit_index),
         max(li.group_position) + 1
  into v_rows, v_next
  from public.line_items as li where li.bill_id = p_bill;
  v_rows := v_rows || pg_temp.rows_of(coalesce(p_add, '[]'), null, v_next);
  select * into v_m from pg_temp.money_of(v_rows, p_tax, v_b.fees_cents, v_b.tip_cents);
  perform pg_temp.as_user((select k from (values ('U'),('T'),('P'),('A'),('S'),('D'),('M'),('L'),('N'),('O')) as x(k)
                           where pg_temp.u(k) = v_b.host_id));
  perform public.update_bill(p_bill, v_rows, v_m.subtotal, p_tax, v_b.fees_cents, v_b.tip_cents, 0, 0, v_m.total);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

create function pg_temp.it(p_bill uuid, p_gp integer, p_ui integer default 0) returns uuid
language sql stable as $f$
  select id from public.line_items where bill_id = p_bill and group_position = p_gp and unit_index = p_ui
$f$;

-- join_bill with the bill's link, as p_who.
create function pg_temp.join(p_bill uuid, p_who text, p_at timestamptz) returns void language plpgsql as $f$
declare v_code text;
begin
  reset role;
  select join_code into v_code from public.bills where id = p_bill;
  perform pg_temp.as_user(p_who);
  perform public.join_bill(v_code);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- set_claim(true) as p_who on each listed unit ('gp' or 'gp.ui'), dated p_at.
create function pg_temp.claim(p_bill uuid, p_who text, p_units text, p_at timestamptz)
returns void language plpgsql as $f$
declare v text; v_id uuid;
begin
  foreach v in array string_to_array(p_units, ' ') loop
    reset role;
    v_id := pg_temp.it(p_bill, split_part(v, '.', 1)::integer, coalesce(nullif(split_part(v, '.', 2), ''), '0')::integer);
    if v_id is null then raise exception 'no row % on %', v, p_bill; end if;
    perform pg_temp.as_user(p_who);
    perform public.set_claim(v_id, true);
  end loop;
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- set_item_split as p_actor (a claimer): parts by letter, e.g. '{"M": 2, "L": 1}'.
create function pg_temp.parts(p_bill uuid, p_actor text, p_gp integer, p_ui integer, p_parts jsonb,
  p_at timestamptz) returns void language plpgsql as $f$
declare v_parts jsonb;
begin
  reset role;
  select jsonb_object_agg(pg_temp.u(e.key)::text, e.value) into v_parts from jsonb_each(p_parts) as e;
  perform pg_temp.as_user(p_actor);
  perform public.set_item_split(pg_temp.it(p_bill, p_gp, p_ui), v_parts);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- computeShares (lib/split.ts) for one person, in SQL: each row split by parts with largest
-- remainder (private.allocate, ties to the lower user id in code-unit order), then the extras
-- (total − Σ rows) proportional to item cents (unclaimed items as a last weight), or equally among
-- people with an item claim. Used for the amount a person pays, exactly as the Settle screen shows.
create function pg_temp.share(p_bill uuid, p_who text) returns integer language plpgsql as $f$
declare
  v_people uuid[];
  v_n integer;
  v_total bigint;
  v_mode text;
  v_items bigint[];
  v_disc bigint[];
  v_has boolean[];
  v_rows bigint := 0;
  v_unclaimed bigint := 0;
  v_extras bigint;
  v_extra integer[];
  r record;
  v_cl uuid[];
  v_pp integer[];
  v_piece integer[];
  v_k integer;
  v_j integer;
  v_me integer;
  v_w integer[];
  v_claimers integer[];
begin
  reset role;
  select array_agg(user_id order by user_id::text collate "C") into v_people
  from public.bill_participants where bill_id = p_bill;
  v_n := cardinality(v_people);
  select total_cents, extras_split into v_total, v_mode from public.bills where id = p_bill;
  v_items := array_fill(0::bigint, array[v_n]);
  v_disc := array_fill(0::bigint, array[v_n]);
  v_has := array_fill(false, array[v_n]);
  for r in select id, kind, total_cents from public.line_items where bill_id = p_bill loop
    v_rows := v_rows + r.total_cents;
    select array_agg(c.user_id order by c.user_id::text collate "C"),
           array_agg(c.parts order by c.user_id::text collate "C")
    into v_cl, v_pp from public.claims as c where c.line_item_id = r.id;
    if v_cl is null then
      if r.kind = 'item' then v_unclaimed := v_unclaimed + r.total_cents; end if;
      continue;
    end if;
    v_piece := private.allocate(r.total_cents, v_pp);
    for v_j in 1 .. cardinality(v_cl) loop
      v_k := array_position(v_people, v_cl[v_j]);
      if r.kind = 'item' then
        v_items[v_k] := v_items[v_k] + v_piece[v_j];
        v_has[v_k] := true;
      else
        v_disc[v_k] := v_disc[v_k] + v_piece[v_j];
      end if;
    end loop;
  end loop;
  v_extras := v_total - v_rows;
  v_extra := array_fill(0, array[v_n]);
  if v_mode = 'equal' then
    select array_agg(i order by i) into v_claimers from generate_series(1, v_n) as i where v_has[i];
    if v_claimers is not null then
      v_piece := private.allocate(v_extras, array_fill(1, array[cardinality(v_claimers)]));
      for v_j in 1 .. cardinality(v_claimers) loop
        v_extra[v_claimers[v_j]] := v_piece[v_j];
      end loop;
    end if;
  else
    v_w := (select array_agg(x::integer) from unnest(v_items) as x) || v_unclaimed::integer;
    if exists (select 1 from unnest(v_w) as x where x <> 0) then
      v_piece := private.allocate(v_extras, v_w);
      v_extra := v_piece[1:v_n];
    end if;
  end if;
  v_me := array_position(v_people, pg_temp.u(p_who));
  return (v_items[v_me] + v_disc[v_me] + v_extra[v_me])::integer;
end $f$;

-- mark_paid as p_who to p_to: their share (computeShares) unless p_cents is given (routes pairs).
create function pg_temp.pay(p_bill uuid, p_who text, p_to text, p_method text, p_at timestamptz,
  p_cents integer default null) returns void language plpgsql as $f$
declare v_cents integer := coalesce(p_cents, pg_temp.share(p_bill, p_who));
begin
  perform pg_temp.as_user(p_who);
  perform public.mark_paid(p_bill, pg_temp.u(p_to), v_cents, p_method, null);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- mark_not_received as the payer, on p_who's current mark.
create function pg_temp.not_received(p_bill uuid, p_payer text, p_who text, p_at timestamptz)
returns void language plpgsql as $f$
declare v_net bigint; v_mark_at timestamptz;
begin
  reset role;
  select ps.net, ps.mark_at into v_net, v_mark_at
  from private.pair_state(p_bill, pg_temp.u(p_who), pg_temp.u(p_payer)) as ps;
  perform pg_temp.as_user(p_payer);
  perform public.mark_not_received(p_bill, pg_temp.u(p_who), pg_temp.u(p_payer), v_net::integer, v_mark_at);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

create function pg_temp.seen(p_bill uuid, p_who text, p_at timestamptz) returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.mark_bill_seen(p_bill);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- Run one host action (a SQL call string with $1 = bill id) as p_who, dated p_at.
create function pg_temp.act(p_bill uuid, p_who text, p_sql text, p_at timestamptz)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  execute p_sql using p_bill;
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- set_payers as the host: '{"P": 4462, "T": 4000}'.
create function pg_temp.payers(p_bill uuid, p_host text, p_split jsonb, p_at timestamptz)
returns void language plpgsql as $f$
declare v jsonb;
begin
  reset role;
  select jsonb_agg(jsonb_build_object('user_id', pg_temp.u(e.key), 'paid_cents', e.value)) into v
  from jsonb_each(p_split) as e;
  perform pg_temp.as_user(p_host);
  perform public.set_payers(p_bill, v);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- Groups.
create function pg_temp.grp(p_id uuid, p_creator text, p_name text, p_at timestamptz)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_creator);
  perform public.create_group(p_id, p_name);
  perform pg_temp.gstamp(p_id, p_at);
end $f$;

create function pg_temp.gjoin(p_group uuid, p_who text, p_at timestamptz) returns void language plpgsql as $f$
declare v_code text;
begin
  reset role;
  select join_code into v_code from public.groups where id = p_group;
  perform pg_temp.as_user(p_who);
  perform public.join_group(v_code);
  perform pg_temp.gstamp(p_group, p_at);
end $f$;

create function pg_temp.attach(p_bill uuid, p_group uuid, p_host text, p_at timestamptz)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_host);
  perform public.attach_bill_to_group(p_bill, p_group);
  perform pg_temp.stamp(p_bill, p_at);
  perform pg_temp.gstamp(p_group, p_at);
end $f$;

create function pg_temp.expense(p_id uuid, p_group uuid, p_creator text, p_title text, p_payer text,
  p_cents bigint, p_method text, p_shares jsonb, p_at timestamptz) returns void language plpgsql as $f$
declare v jsonb;
begin
  reset role;
  select jsonb_object_agg(pg_temp.u(e.key)::text, e.value) into v from jsonb_each(p_shares) as e;
  perform pg_temp.as_user(p_creator);
  perform public.add_expense(p_id, p_group, p_title, pg_temp.u(p_payer), p_cents, p_method, v);
  perform pg_temp.gstamp(p_group, p_at);
end $f$;

create function pg_temp.gpay(p_id uuid, p_group uuid, p_recorder text, p_from text, p_to text,
  p_cents bigint, p_method text, p_source text, p_at timestamptz) returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_recorder);
  perform public.record_payment(p_id, p_group, pg_temp.u(p_from), pg_temp.u(p_to), p_cents, p_method, p_source);
  perform pg_temp.gstamp(p_group, p_at);
end $f$;

create function pg_temp.gundo(p_id uuid, p_group uuid, p_who text, p_at timestamptz)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.undo_payment(p_id);
  perform pg_temp.gstamp(p_group, p_at);
end $f$;

create function pg_temp.not_part(p_bill uuid, p_who text, p_at timestamptz) returns void language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.set_not_part(p_bill, true);
  perform pg_temp.stamp(p_bill, p_at);
end $f$;

-- ---------------------------------------------------------------------------------------------
-- The bills. Times are IST (+05:30), the user's local time. Letters: U = you, T Tejesh, P Priya,
-- A Arjun, S Sam, D Dee, M Maya, L Leo, N Nina.
-- ---------------------------------------------------------------------------------------------

-- B1 Host, nobody joined yet: you scanned brunch, claimed your two things; the rest is open.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Cappuccino",2,450],["Avocado sourdough toast",1,1450],["Shakshuka",1,1600],
    ["Banana bread",1,650],["Cold brew tonic",1,550]]', 258, 0, 500,
    '2026-11-27 13:10+05:30', 'Demo: you host, nobody has joined yet');
  perform pg_temp.claim(b, 'U', '0.0 2', '2026-11-27 13:14+05:30');
end $$;

-- B2 Host, some joined: Priya claimed hers, Arjun joined but hasn't claimed; items still open.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Karaage",1,1200],["Gyoza",2,850],["Agedashi tofu",1,900],
    ["Salmon ikura don",1,1900],["Yakitori moriawase",1,1600],["Sapporo draft",3,700],
    ["Hojicha ice cream",1,600]]', 875, 0, 1800,
    '2026-11-26 20:30+05:30', 'Demo: you host, some people joined, items left');
  perform pg_temp.claim(b, 'U', '3 5.0', '2026-11-26 20:33+05:30');
  perform pg_temp.join(b, 'P', '2026-11-26 20:41+05:30');
  perform pg_temp.claim(b, 'P', '0 5.1', '2026-11-26 20:44+05:30');
  perform pg_temp.join(b, 'A', '2026-11-26 21:02+05:30');
end $$;

-- B3 Ready to settle, proportional (the default), and the big bill: 8 people, 17 rows, shared and
-- custom-split items, a claimable happy-hour discount row, a service fee. Nobody has paid yet.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Nachos grande",1,1400],["Peri peri wings",2,1100],["Loaded fries",1,900],
    ["Margherita pizza",1,1600],["Pepperoni pizza",1,1800],["Mushroom risotto",1,1700],
    ["Fish and chips",1,1900],["Paneer tikka skewers",1,1500],["Chicken burger",2,1650],
    ["Caesar salad",1,1200],["Basmati Blonde pitcher",2,2400],["Tintin Toit pint",4,750],
    ["Fresh lime soda",2,350],["Brownie sundae",1,950],["Tiramisu",1,1050],["Espresso",3,300],
    ["Happy hour pitchers",-1200,"subtotal"]]', 1662, 1385, 2000,
    '2026-11-22 21:00+05:30', 'Demo: ready to settle (proportional), big table, discount');
  perform pg_temp.join(b, 'T', '2026-11-22 21:05+05:30');
  perform pg_temp.join(b, 'P', '2026-11-22 21:06+05:30');
  perform pg_temp.join(b, 'A', '2026-11-22 21:06+05:30');
  perform pg_temp.join(b, 'S', '2026-11-22 21:08+05:30');
  perform pg_temp.join(b, 'D', '2026-11-22 21:09+05:30');
  perform pg_temp.join(b, 'M', '2026-11-22 21:11+05:30');
  perform pg_temp.join(b, 'L', '2026-11-22 21:15+05:30');
  perform pg_temp.claim(b, 'U', '0 3 10.0 11.2 13 16', '2026-11-22 21:20+05:30');
  perform pg_temp.claim(b, 'T', '0 4 10.0 11.3 14 16', '2026-11-22 21:21+05:30');
  perform pg_temp.claim(b, 'P', '0 5 11.0 12.1 13', '2026-11-22 21:22+05:30');
  perform pg_temp.claim(b, 'A', '0 6 10.0 15.0 16', '2026-11-22 21:23+05:30');
  perform pg_temp.claim(b, 'S', '1.0 7 10.1 15.2 16', '2026-11-22 21:24+05:30');
  perform pg_temp.claim(b, 'D', '1.1 8.0 10.1 15.1 16', '2026-11-22 21:25+05:30');
  perform pg_temp.claim(b, 'M', '2 9 11.1 12.0 13', '2026-11-22 21:26+05:30');
  perform pg_temp.claim(b, 'L', '2 8.1 10.1 14 16', '2026-11-22 21:27+05:30');
  -- Maya had most of the loaded fries.
  perform pg_temp.parts(b, 'M', 2, 0, '{"M": 2, "L": 1}', '2026-11-22 21:30+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-22 21:35+05:30');
end $$;

-- B4 Ready to settle, extras split evenly, and a zero-tip bill.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Large cheese pizza",1,2400],["Large pepperoni pizza",1,2800],
    ["Garlic knots",1,700],["Caesar salad",1,1100],["Fountain soda",4,300],["Cannoli",2,450]]',
    808, 0, 0, '2026-11-24 22:15+05:30', 'Demo: ready to settle, split evenly, no tip');
  perform pg_temp.act(b, 'U', 'select public.set_extras_split($1, ''equal'')', '2026-11-24 22:16+05:30');
  perform pg_temp.join(b, 'T', '2026-11-24 22:18+05:30');
  perform pg_temp.join(b, 'P', '2026-11-24 22:19+05:30');
  perform pg_temp.join(b, 'S', '2026-11-24 22:21+05:30');
  perform pg_temp.claim(b, 'U', '0 2 4.0', '2026-11-24 22:25+05:30');
  perform pg_temp.claim(b, 'T', '0 4.1 5.0', '2026-11-24 22:26+05:30');
  perform pg_temp.claim(b, 'P', '1 3 4.2', '2026-11-24 22:27+05:30');
  perform pg_temp.claim(b, 'S', '1 4.3 5.1', '2026-11-24 22:28+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-24 22:30+05:30');
end $$;

-- B5 Partly paid: Priya paid cash, Arjun's Venmo you marked "Not received", Tejesh just sent via
-- Venmo (newer than your last look, so Home shows it), Sam hasn't paid.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Totopos con guacamole",1,1300],["Carnitas tacos",1,1800],
    ["Pollo al pastor tacos",1,1700],["Enchiladas de mole",1,2100],["Quesadilla",1,1500],
    ["Chile relleno",1,1900],["Horchata",3,500],["Margarita",2,1200]]', 1225, 0, 2556,
    '2026-11-20 21:00+05:30', 'Demo: partly paid (Venmo, cash, not received)');
  perform pg_temp.join(b, 'T', '2026-11-20 21:03+05:30');
  perform pg_temp.join(b, 'P', '2026-11-20 21:04+05:30');
  perform pg_temp.join(b, 'A', '2026-11-20 21:04+05:30');
  perform pg_temp.join(b, 'S', '2026-11-20 21:06+05:30');
  perform pg_temp.claim(b, 'U', '0 5 6.2', '2026-11-20 21:10+05:30');
  perform pg_temp.claim(b, 'T', '0 1 6.0', '2026-11-20 21:11+05:30');
  perform pg_temp.claim(b, 'P', '0 2 6.1', '2026-11-20 21:12+05:30');
  perform pg_temp.claim(b, 'A', '0 3 7.0', '2026-11-20 21:13+05:30');
  perform pg_temp.claim(b, 'S', '0 4 7.1', '2026-11-20 21:14+05:30');
  perform pg_temp.pay(b, 'P', 'U', 'cash', '2026-11-20 23:30+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-21 09:00+05:30');
  perform pg_temp.pay(b, 'A', 'U', 'venmo', '2026-11-21 12:00+05:30');
  perform pg_temp.not_received(b, 'U', 'A', '2026-11-22 10:00+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-22 10:01+05:30');
  perform pg_temp.pay(b, 'T', 'U', 'venmo', '2026-11-23 19:00+05:30');
end $$;

-- B6 Differences: everyone paid, then you fixed two prices. Dee now owes a bit more, and you owe
-- Maya some back. Total unchanged.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Tea leaf salad",1,1700],["Rainbow salad",1,1600],["Samusa soup",1,1100],
    ["Nan gyi thoke",1,1650],["Mohinga",1,1500],["Coconut rice",2,450],["Pumpkin pork stew",1,1800],
    ["Thai iced tea",2,550]]', 979, 0, 2000,
    '2026-11-18 20:00+05:30', 'Demo: paid, then prices changed (differences)');
  perform pg_temp.join(b, 'D', '2026-11-18 20:04+05:30');
  perform pg_temp.join(b, 'M', '2026-11-18 20:05+05:30');
  perform pg_temp.join(b, 'L', '2026-11-18 20:05+05:30');
  perform pg_temp.claim(b, 'U', '0 5.0 6', '2026-11-18 20:10+05:30');
  perform pg_temp.claim(b, 'D', '0 1 3 7.0', '2026-11-18 20:11+05:30');
  perform pg_temp.claim(b, 'M', '0 1 4 7.1', '2026-11-18 20:12+05:30');
  perform pg_temp.claim(b, 'L', '0 2 5.1', '2026-11-18 20:13+05:30');
  perform pg_temp.pay(b, 'D', 'U', 'venmo', '2026-11-18 22:10+05:30');
  perform pg_temp.pay(b, 'M', 'U', 'venmo', '2026-11-18 22:40+05:30');
  perform pg_temp.pay(b, 'L', 'U', 'cash', '2026-11-19 09:15+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-19 10:00+05:30');
  perform pg_temp.edit(b, '[[3,0,1950],[4,0,1200]]', null, 979, '2026-11-19 10:05+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-19 10:06+05:30');
end $$;

-- B7 Fully settled, an older bill.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Roast chicken for two",1,5800],["Caesar salad",1,1600],
    ["Shoestring fries",1,900],["Oysters (half dozen)",1,2100],["Espresso granita",1,1000],
    ["Glass of wine",3,1400]]', 1346, 0, 3000,
    '2026-11-04 20:30+05:30', 'Demo: fully settled');
  perform pg_temp.join(b, 'T', '2026-11-04 20:34+05:30');
  perform pg_temp.join(b, 'P', '2026-11-04 20:35+05:30');
  perform pg_temp.claim(b, 'U', '0 2 5.0', '2026-11-04 20:40+05:30');
  perform pg_temp.claim(b, 'T', '0 2 4 5.1', '2026-11-04 20:41+05:30');
  perform pg_temp.claim(b, 'P', '1 2 3 5.2', '2026-11-04 20:42+05:30');
  perform pg_temp.pay(b, 'T', 'U', 'venmo', '2026-11-04 23:05+05:30');
  perform pg_temp.pay(b, 'P', 'U', 'cash', '2026-11-05 12:30+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-05 13:00+05:30');
end $$;

-- B8 Guest, you owe the host: Priya's bill, Tejesh already paid her.
do $$
declare b uuid;
begin
  b := pg_temp.bill('P', '[["Butter chicken",1,1800],["Dal makhani",1,1400],["Garlic naan",3,400],
    ["Lamb biryani",1,2000],["Mango lassi",2,500],["Gulab jamun",1,700]]', 729, 0, 1200,
    '2026-11-25 21:30+05:30', 'Demo: you owe Priya');
  perform pg_temp.join(b, 'U', '2026-11-25 21:34+05:30');
  perform pg_temp.join(b, 'T', '2026-11-25 21:35+05:30');
  perform pg_temp.claim(b, 'P', '1 2.1 4.1', '2026-11-25 21:38+05:30');
  perform pg_temp.claim(b, 'U', '0 2.0 4.0 5', '2026-11-25 21:39+05:30');
  perform pg_temp.claim(b, 'T', '2.2 3 5', '2026-11-25 21:40+05:30');
  perform pg_temp.pay(b, 'T', 'P', 'venmo', '2026-11-26 09:20+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-26 10:00+05:30');
end $$;

-- B9 Guest, you already paid: Arjun's lunch (hidden from Home; counted in "Bills you've paid").
do $$
declare b uuid;
begin
  b := pg_temp.bill('A', '[["Harvest bowl",1,1495],["Kale caesar",1,1395],["Shroomami bowl",1,1495],
    ["Lemonade",3,395]]', 487, 0, 0,
    '2026-11-15 13:00+05:30', 'Demo: you already paid Arjun');
  perform pg_temp.join(b, 'U', '2026-11-15 13:02+05:30');
  perform pg_temp.join(b, 'P', '2026-11-15 13:03+05:30');
  perform pg_temp.claim(b, 'A', '1 3.1', '2026-11-15 13:05+05:30');
  perform pg_temp.claim(b, 'U', '0 3.0', '2026-11-15 13:06+05:30');
  perform pg_temp.claim(b, 'P', '2 3.2', '2026-11-15 13:07+05:30');
  perform pg_temp.pay(b, 'U', 'A', 'venmo', '2026-11-15 14:00+05:30');
  perform pg_temp.pay(b, 'P', 'A', 'cash', '2026-11-15 18:30+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-15 18:45+05:30');
end $$;

-- B10 Guest, owed money back: you paid Tejesh, then he fixed your ramen's price.
do $$
declare b uuid;
begin
  b := pg_temp.bill('T', '[["Shiromaru ramen",1,1700],["Akamaru ramen",1,1800],["Karaka ramen",1,1900],
    ["Pork buns",2,900],["Edamame",1,600],["Asahi",3,800]]', 880, 0, 1800,
    '2026-11-12 20:00+05:30', 'Demo: Tejesh owes you some back');
  perform pg_temp.join(b, 'U', '2026-11-12 20:03+05:30');
  perform pg_temp.join(b, 'S', '2026-11-12 20:04+05:30');
  perform pg_temp.claim(b, 'T', '1 4 5.1', '2026-11-12 20:08+05:30');
  perform pg_temp.claim(b, 'U', '0 3.0 4 5.0', '2026-11-12 20:09+05:30');
  perform pg_temp.claim(b, 'S', '2 3.1 4 5.2', '2026-11-12 20:10+05:30');
  perform pg_temp.pay(b, 'U', 'T', 'venmo', '2026-11-12 22:00+05:30');
  perform pg_temp.pay(b, 'S', 'T', 'venmo', '2026-11-12 22:30+05:30');
  perform pg_temp.edit(b, '[[0,0,1300]]', null, 846, '2026-11-13 11:00+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-13 12:00+05:30');
end $$;

-- B11 Guest, new and unseen: Tejesh added you (you haven't opened it), nothing claimed by you.
do $$
declare b uuid;
begin
  b := pg_temp.bill('T', '[["Chilli cheese toast",1,700],["Keema pav",1,1100],
    ["Butter garlic prawns",1,1600],["Long Island iced tea",2,1200],["Virgin mojito",1,500]]',
    1134, 0, 600, '2026-11-27 12:30+05:30', 'Demo: new, Tejesh added you');
  perform pg_temp.claim(b, 'T', '1 3.0', '2026-11-27 12:35+05:30');
  perform pg_temp.act(b, 'T', format('select public.add_participant($1, %L)', pg_temp.u('U')),
    '2026-11-27 12:40+05:30');
end $$;

-- B12 Guest, items still to claim: you opened Sam's link but haven't claimed anything.
do $$
declare b uuid;
begin
  b := pg_temp.bill('S', '[["Bacon naan roll",1,1100],["Chicken ruby",1,1800],["Black daal",1,1300],
    ["House chaat",1,900],["Masala chai",3,400]]', 560, 0, 1000,
    '2026-11-26 13:30+05:30', 'Demo: claim your items on Sam''s bill');
  perform pg_temp.claim(b, 'S', '1 4.0', '2026-11-26 13:33+05:30');
  perform pg_temp.join(b, 'D', '2026-11-26 13:35+05:30');
  perform pg_temp.claim(b, 'D', '0 4.1', '2026-11-26 13:36+05:30');
  perform pg_temp.join(b, 'U', '2026-11-26 13:40+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-26 13:41+05:30');
end $$;

-- B13 Settle early: Dee's bill isn't fully claimed (Maya hasn't claimed), but it's one payer and
-- proportional, so anyone with an item claim can pay now. Leo already did; you can.
do $$
declare b uuid;
begin
  b := pg_temp.bill('D', '[["Mezze platter",1,1800],["Lamb kofta",1,2200],["Falafel wrap",1,1400],
    ["Grilled halloumi",1,1600],["Baklava",1,900],["Mint lemonade",3,450],["Moussaka",1,2000]]',
    1012, 0, 2000, '2026-11-23 20:00+05:30', 'Demo: settle early (items still unclaimed)');
  perform pg_temp.claim(b, 'D', '5.2 6', '2026-11-23 20:03+05:30');
  perform pg_temp.join(b, 'U', '2026-11-23 20:05+05:30');
  perform pg_temp.join(b, 'L', '2026-11-23 20:06+05:30');
  perform pg_temp.join(b, 'M', '2026-11-23 20:07+05:30');
  perform pg_temp.claim(b, 'U', '0 1 5.0', '2026-11-23 20:10+05:30');
  perform pg_temp.claim(b, 'L', '0 2 5.1', '2026-11-23 20:11+05:30');
  perform pg_temp.pay(b, 'L', 'D', 'cash', '2026-11-23 22:00+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-24 09:00+05:30');
end $$;

-- B14 Who paid, two payers: Priya put $44.62 on her card and Tejesh paid $40.00 cash. You owe
-- both; Arjun (just a drink and fries) has paid his part.
do $$
declare b uuid;
begin
  b := pg_temp.bill('P', '[["Spaghetti aglio e olio",1,1450],["Chicken schnitzel",1,1750],
    ["Grilled chicken sandwich",1,1250],["Iced tea",1,350],["Big breakfast",1,1520],
    ["Truffle fries",1,350]]', 592, 0, 1200,
    '2026-11-21 21:00+05:30', 'Demo: two people paid, you owe both');
  perform pg_temp.join(b, 'T', '2026-11-21 21:03+05:30');
  perform pg_temp.join(b, 'U', '2026-11-21 21:04+05:30');
  perform pg_temp.join(b, 'A', '2026-11-21 21:05+05:30');
  perform pg_temp.claim(b, 'P', '0 5', '2026-11-21 21:08+05:30');
  perform pg_temp.claim(b, 'T', '1 5', '2026-11-21 21:09+05:30');
  perform pg_temp.claim(b, 'U', '2 4 5', '2026-11-21 21:10+05:30');
  perform pg_temp.claim(b, 'A', '3 5', '2026-11-21 21:11+05:30');
  perform pg_temp.payers(b, 'P', '{"P": 4462, "T": 4000}', '2026-11-21 21:20+05:30');
  -- Arjun's two routes (contract T's pairs; checked by the verify script).
  -- Arjun's one route (contract T's pair, lib/transfers.ts; checked by running ledgerSettlePlan).
  perform pg_temp.pay(b, 'A', 'T', 'cash', '2026-11-22 08:30+05:30', 554);
  perform pg_temp.seen(b, 'U', '2026-11-22 09:00+05:30');
end $$;

-- B15 Who paid, split, you're a co-payer and owed: you paid $90.00, Maya $48.99. Leo has paid
-- his part; Nina hasn't.
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Dal chawal arancini",1,1400],["Galouti kebab",1,1900],
    ["Butter chicken bao",1,1600],["Mishti doi cannoli",1,1100],["Truffle khichdi",1,1700],
    ["Raspberry rasam",1,800],["Mocktail",4,650]]', 999, 0, 1800,
    '2026-11-19 20:45+05:30', 'Demo: you and Maya paid, you are owed');
  perform pg_temp.join(b, 'M', '2026-11-19 20:48+05:30');
  perform pg_temp.join(b, 'L', '2026-11-19 20:49+05:30');
  perform pg_temp.join(b, 'N', '2026-11-19 20:51+05:30');
  perform pg_temp.claim(b, 'U', '0 4 6.0', '2026-11-19 20:55+05:30');
  perform pg_temp.claim(b, 'M', '0 1 6.1', '2026-11-19 20:56+05:30');
  perform pg_temp.claim(b, 'L', '0 2 6.2', '2026-11-19 20:57+05:30');
  perform pg_temp.claim(b, 'N', '0 3 5 6.3', '2026-11-19 20:58+05:30');
  perform pg_temp.payers(b, 'U', '{"U": 9000, "M": 4899}', '2026-11-19 21:05+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-19 21:06+05:30');
  -- Leo's two routes (contract T's pairs, checked with ledgerSettlePlan). His Venmo to you is
  -- newer than your last look, so Home shows it.
  perform pg_temp.pay(b, 'L', 'M', 'cash', '2026-11-20 10:00+05:30', 1268);
  perform pg_temp.pay(b, 'L', 'U', 'venmo', '2026-11-20 10:02+05:30', 1988);
end $$;

-- B16 Who paid, stale split: Arjun split the paying with Sam, then added an item, so the split
-- no longer adds up to the total. Nobody can settle until Arjun fixes it.
do $$
declare b uuid;
begin
  b := pg_temp.bill('A', '[["Classic smash burger",2,950],["Paneer tikka burger",1,900],
    ["Peri peri fries",1,500],["Oreo shake",2,600]]', 405, 0, 500,
    '2026-11-17 21:00+05:30', 'Demo: who paid no longer adds up');
  perform pg_temp.join(b, 'S', '2026-11-17 21:02+05:30');
  perform pg_temp.join(b, 'U', '2026-11-17 21:03+05:30');
  perform pg_temp.claim(b, 'A', '0.0 2', '2026-11-17 21:06+05:30');
  perform pg_temp.claim(b, 'U', '0.1 2 3.0', '2026-11-17 21:07+05:30');
  perform pg_temp.claim(b, 'S', '1 2 3.1', '2026-11-17 21:08+05:30');
  perform pg_temp.payers(b, 'A', '{"A": 3000, "S": 2405}', '2026-11-17 21:15+05:30');
  perform pg_temp.edit(b, '[]', '[["Extra cheese",1,150]]', 419, '2026-11-18 09:30+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-18 10:00+05:30');
end $$;

-- B17 Who paid changed after a payment: Tejesh paid you, then you set Priya as the payer (her
-- card). You now owe Priya your share plus Tejesh's money (passed on).
do $$
declare b uuid;
begin
  b := pg_temp.bill('U', '[["Hot and sour soup",2,550],["Chilli chicken",1,1500],
    ["Veg hakka noodles",1,1200],["Kung pao prawns",1,1900],["Dim sum basket",1,1300]]',
    630, 0, 1000, '2026-11-13 20:00+05:30', 'Demo: payer changed after Tejesh paid you');
  perform pg_temp.join(b, 'T', '2026-11-13 20:03+05:30');
  perform pg_temp.join(b, 'P', '2026-11-13 20:04+05:30');
  perform pg_temp.claim(b, 'U', '0.0 3 4', '2026-11-13 20:08+05:30');
  perform pg_temp.claim(b, 'T', '0.1 1 4', '2026-11-13 20:09+05:30');
  perform pg_temp.claim(b, 'P', '2 4', '2026-11-13 20:10+05:30');
  perform pg_temp.pay(b, 'T', 'U', 'venmo', '2026-11-13 23:00+05:30');
  perform pg_temp.act(b, 'U', format('select public.set_payer($1, %L)', pg_temp.u('P')),
    '2026-11-14 10:00+05:30');
  perform pg_temp.seen(b, 'U', '2026-11-14 10:01+05:30');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Group 1: "Goa trip (demo)". You, Tejesh, Priya, Arjun, Maya. Three receipts (one still needs
-- your claim), three shared costs, payments recorded, undone ("not received" and by the sender),
-- and two "I wasn't part of this" opt-outs.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  g uuid := 'de0000a0-0000-0000-0000-000000000001';
  b uuid;
begin
  perform pg_temp.grp(g, 'U', 'Goa trip (demo)', '2026-11-06 10:00+05:30');
  perform pg_temp.gjoin(g, 'T', '2026-11-06 10:05+05:30');
  perform pg_temp.gjoin(g, 'P', '2026-11-06 10:12+05:30');
  perform pg_temp.gjoin(g, 'A', '2026-11-06 10:40+05:30');
  perform pg_temp.gjoin(g, 'M', '2026-11-06 11:02+05:30');

  perform pg_temp.expense('de0000e0-0000-0000-0000-000000000001', g, 'U', 'Villa Anjuna, 3 nights',
    'U', 64000, 'equal', '{"U":1,"T":1,"P":1,"A":1,"M":1}', '2026-11-06 12:00+05:30');
  perform pg_temp.expense('de0000e0-0000-0000-0000-000000000002', g, 'A', 'Scooter rentals',
    'A', 9000, 'exact', '{"A":2400,"T":2400,"P":2400,"U":1800}', '2026-11-07 10:00+05:30');

  -- Receipt 1: split as a normal bill first (Tejesh paid you cash), then moved into the group, so
  -- his mark became a group payment (source bill_mark).
  b := pg_temp.bill('U', '[["Greek salad",1,1400],["Fried calamari",1,1600],["Moussaka",1,2200],
    ["Lamb souvlaki",2,1900],["Prawn saganaki",1,2100],["Sangria pitcher",2,2800]]', 835, 0, 1500,
    '2026-11-07 21:30+05:30', 'Demo: group receipt, paid before it moved in');
  perform pg_temp.join(b, 'T', '2026-11-07 21:33+05:30');
  perform pg_temp.join(b, 'P', '2026-11-07 21:33+05:30');
  perform pg_temp.join(b, 'A', '2026-11-07 21:34+05:30');
  perform pg_temp.join(b, 'M', '2026-11-07 21:35+05:30');
  perform pg_temp.claim(b, 'U', '0 3.0 5.0', '2026-11-07 21:40+05:30');
  perform pg_temp.claim(b, 'T', '0 1 5.0', '2026-11-07 21:41+05:30');
  perform pg_temp.claim(b, 'P', '0 2 5.0', '2026-11-07 21:42+05:30');
  perform pg_temp.claim(b, 'A', '0 1 3.1 5.1', '2026-11-07 21:43+05:30');
  perform pg_temp.claim(b, 'M', '0 4 5.1', '2026-11-07 21:44+05:30');
  perform pg_temp.pay(b, 'T', 'U', 'cash', '2026-11-07 23:00+05:30');
  perform pg_temp.attach(b, g, 'U', '2026-11-08 09:00+05:30');

  perform pg_temp.expense('de0000e0-0000-0000-0000-000000000003', g, 'M', 'Dudhsagar jeep safari',
    'M', 12000, 'equal', '{"T":1,"P":1,"M":1,"U":1}', '2026-11-08 07:00+05:30');

  -- Receipt 2: Priya's lunch, fully claimed; Maya wasn't there.
  b := pg_temp.bill('P', '[["Fish thali",2,900],["Prawn curry rice",1,1100],["Pork vindaloo",1,1200],
    ["Kingfish fry",1,1300],["Kokum soda",4,250]]', 320, 0, 600,
    '2026-11-08 13:00+05:30', 'Demo: group receipt, Maya wasn''t part of it');
  perform pg_temp.attach(b, g, 'P', '2026-11-08 13:02+05:30');
  perform pg_temp.claim(b, 'P', '0.0 3 4.0', '2026-11-08 13:05+05:30');
  perform pg_temp.claim(b, 'T', '0.1 3 4.1', '2026-11-08 13:06+05:30');
  perform pg_temp.claim(b, 'A', '1 3 4.2', '2026-11-08 13:07+05:30');
  perform pg_temp.claim(b, 'U', '2 3 4.3', '2026-11-08 13:08+05:30');
  perform pg_temp.not_part(b, 'M', '2026-11-08 15:00+05:30');

  -- Receipt 3: Tejesh's dinner, still being claimed. The crab and one feni are yours to claim;
  -- Arjun wasn't there.
  b := pg_temp.bill('T', '[["Lobster thermidor",1,3800],["Crab xec xec",1,2400],["Bebinca",1,700],
    ["Feni cocktail",3,600],["Garlic bread",1,500]]', 460, 0, 900,
    '2026-11-09 20:00+05:30', 'Demo: group receipt, claim your items');
  perform pg_temp.attach(b, g, 'T', '2026-11-09 20:02+05:30');
  perform pg_temp.claim(b, 'T', '0 3.0', '2026-11-09 20:05+05:30');
  perform pg_temp.claim(b, 'P', '4 3.1', '2026-11-09 20:06+05:30');
  perform pg_temp.claim(b, 'M', '2', '2026-11-09 20:07+05:30');
  perform pg_temp.not_part(b, 'A', '2026-11-09 22:00+05:30');

  -- Payments: recorded (Venmo link, cash), Arjun's $24.00 you marked "not received", and one
  -- Maya undid herself (sender).
  perform pg_temp.gpay('de0000f0-0000-0000-0000-000000000001', g, 'T', 'T', 'U', 12800, 'venmo',
    'venmo_link', '2026-11-10 10:00+05:30');
  perform pg_temp.gpay('de0000f0-0000-0000-0000-000000000003', g, 'A', 'A', 'U', 2400, 'venmo',
    'manual', '2026-11-10 12:00+05:30');
  perform pg_temp.gundo('de0000f0-0000-0000-0000-000000000003', g, 'U', '2026-11-11 09:00+05:30');
  perform pg_temp.gpay('de0000f0-0000-0000-0000-000000000002', g, 'U', 'P', 'U', 5000, 'cash',
    'manual', '2026-11-11 19:00+05:30');
  perform pg_temp.gpay('de0000f0-0000-0000-0000-000000000004', g, 'M', 'M', 'A', 10000, 'venmo',
    'manual', '2026-11-12 08:00+05:30');
  perform pg_temp.gundo('de0000f0-0000-0000-0000-000000000004', g, 'M', '2026-11-12 08:05+05:30');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Group 2: "Flat 4B (demo)". Sam, you, Dee, Leo. Household costs, one grocery receipt, two
-- payments; you still owe.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  g uuid := 'de0000a0-0000-0000-0000-000000000002';
  b uuid;
begin
  perform pg_temp.grp(g, 'S', 'Flat 4B (demo)', '2026-11-01 10:00+05:30');
  perform pg_temp.gjoin(g, 'U', '2026-11-01 10:20+05:30');
  perform pg_temp.gjoin(g, 'D', '2026-11-01 11:00+05:30');
  perform pg_temp.gjoin(g, 'L', '2026-11-01 18:30+05:30');
  perform pg_temp.expense('de0000e0-0000-0000-0000-000000000004', g, 'S', 'Costco run',
    'S', 18640, 'equal', '{"S":1,"U":1,"D":1,"L":1}', '2026-11-02 17:00+05:30');
  perform pg_temp.expense('de0000e0-0000-0000-0000-000000000005', g, 'D', 'Internet, November',
    'D', 5999, 'equal', '{"S":1,"U":1,"D":1,"L":1}', '2026-11-03 09:00+05:30');
  perform pg_temp.expense('de0000e0-0000-0000-0000-000000000006', g, 'U', 'Cleaning supplies',
    'U', 2350, 'exact', '{"S":600,"D":600,"L":600,"U":550}', '2026-11-05 19:00+05:30');
  perform pg_temp.gpay('de0000f0-0000-0000-0000-000000000005', g, 'U', 'U', 'S', 3000, 'venmo',
    'venmo_link', '2026-11-20 08:00+05:30');
  perform pg_temp.gpay('de0000f0-0000-0000-0000-000000000006', g, 'D', 'L', 'D', 1500, 'cash',
    'manual', '2026-11-21 20:00+05:30');

  b := pg_temp.bill('D', '[["Mandarin orange chicken",2,499],["Everything bagel seasoning",1,249],
    ["Oat milk",3,349],["Cauliflower gnocchi",2,329],["Dark chocolate PB cups",1,449],
    ["Flowers",1,599]]', 0, 0, 0, '2026-11-22 18:00+05:30', 'Demo: flat groceries');
  perform pg_temp.attach(b, g, 'D', '2026-11-22 18:02+05:30');
  perform pg_temp.claim(b, 'S', '0.0 4 5', '2026-11-22 18:10+05:30');
  perform pg_temp.claim(b, 'L', '0.1 2.2 5', '2026-11-22 18:11+05:30');
  perform pg_temp.claim(b, 'U', '1 2.0 3.1 5', '2026-11-22 18:12+05:30');
  perform pg_temp.claim(b, 'D', '2.1 3.0 5', '2026-11-22 18:13+05:30');

  -- A pizza night you missed: you said "I wasn't part of this".
  b := pg_temp.bill('L', '[["Large margherita",1,1899],["Garlic bread",1,699],["Two-liter soda",1,349]]',
    0, 0, 0, '2026-11-24 21:00+05:30', 'Demo: flat pizza night, you weren''t there');
  perform pg_temp.attach(b, g, 'L', '2026-11-24 21:01+05:30');
  perform pg_temp.claim(b, 'L', '0 1 2', '2026-11-24 21:05+05:30');
  perform pg_temp.claim(b, 'S', '0 2', '2026-11-24 21:05+05:30');
  perform pg_temp.claim(b, 'D', '0 1', '2026-11-24 21:06+05:30');
  perform pg_temp.not_part(b, 'U', '2026-11-25 08:00+05:30');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Home order: my_bills lists 20 bills by joined_at, newest first. Move joined_at of the demo
-- bills dated before 2026-11-21 13:40 IST to just after it (same order as their dates), so the
-- two that fall past the limit are the user's two oldest test bills (Nov 21), not demo bills.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  set local session_replication_role = replica;
  update public.bill_participants as bp
  set joined_at = timestamptz '2026-11-21 13:40+05:30' + make_interval(secs => r.n)
  from (
    select b.id, row_number() over (order by b.created_at) as n
    from public.bills as b
    where b.join_code like 'de0de0%' and b.group_id is null
      and b.created_at < timestamptz '2026-11-21 13:40+05:30'
  ) as r
  where bp.bill_id = r.id;
  set local session_replication_role = origin;
end $$;

commit;
\echo 'Demo data seeded.'
