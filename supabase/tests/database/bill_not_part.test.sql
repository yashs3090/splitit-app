-- pgTAP tests for the group claim status T1 migration (20261127150000_bill_not_part.sql; spec
-- docs/specs/2026-11-27-group-claim-status.md C3, C4; criteria 1-11).
--
-- Every assertion filters to the fixture users / groups / bills below (the local DB may hold real
-- data). Fixture user ids start with e8000000.
-- Users: Ana ..01 (creates G1 and G2, hosts every bill), Ben ..02, Cy ..03, Dee ..04 (members of
--   G1; Ben also of G2), Sam ..06 (a stranger to everything).
-- Groups: G1 ..a1 (Ana, Ben, Cy, Dee), G2 ..a2 (Ana, Ben).
-- Bills: B1 in G1: Tacos 1000 (Ana), Nachos 900, Beer 500 (unclaimed).
--        B3 in G1: Pizza 2000 (split Ana 1 / Cy 1 through assign_item), Soda 300 (unclaimed).
--        B4 in G1: Wings 800 (unclaimed).
--        B2 in G2: Gas 4000 (unclaimed).
--        B0 not in a group: Solo 1500; Ben joined by link.
-- Expense X1 in G1 (so the "changes nothing" fingerprint covers a live expense row).

begin;

create extension if not exists pgtap with schema extensions;

select plan(62);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('e8000000-0000-0000-0000-0000000000' || p)::uuid
$$;
create function pg_temp.x(p text) returns uuid language sql immutable as $$
  select ('e8000000-0000-0000-0002-0000000000' || p)::uuid
$$;

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- SQL that runs as p_user (authenticated); used by lives_ok / throws_ok.
create function pg_temp.as_sql(p_user uuid, p_sql text) returns text language sql immutable as $$
  select format(
    'select set_config(''request.jwt.claims'', %L, true); set local role authenticated; %s',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, p_sql)
$$;

-- Run p_sql as p_user (authenticated), then return to the test's role.
create function pg_temp.run(p_user uuid, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  execute p_sql;
  reset role;
end $$;

create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.bill_' || p_tag)::uuid $$;
create function pg_temp.li(p_tag text, p_name text) returns uuid language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.name = p_name and li.unit_index = 0
$$;
create function pg_temp.gcode(p_group uuid) returns text language sql stable as
  $$ select g.join_code from public.groups as g where g.id = p_group $$;

-- As p_host: create a bill (one unit per row), then let each of p_joiners join it by link.
create function pg_temp.mk(p_tag text, p_host uuid, p_rows jsonb, p_total integer,
                           p_joiners uuid[] default '{}') returns void language plpgsql as $$
declare r record; j uuid;
begin
  perform pg_temp.act(p_host);
  set local role authenticated;
  select * into r from public.create_bill(p_rows, null, 0, 0, 0, 0, 0, p_total);
  reset role;
  perform set_config('test.bill_' || p_tag, r.bill_id::text, true);
  foreach j in array p_joiners loop
    perform pg_temp.act(j);
    set local role authenticated;
    perform public.join_bill(r.join_code);
    reset role;
  end loop;
end $$;

-- set_not_part as p_user, as a SQL string for lives_ok / throws_ok.
create function pg_temp.np(p_user uuid, p_tag text, p_not_part boolean) returns text
language sql stable as $$
  select pg_temp.as_sql(p_user, format('select public.set_not_part(%L, %L)', pg_temp.bid(p_tag), p_not_part))
$$;

-- Does (bill, user) have a bill_not_part row? (Read as the test's superuser.)
create function pg_temp.has_np(p_tag text, p_user uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.bill_not_part as n
                 where n.bill_id = pg_temp.bid(p_tag) and n.user_id = p_user)
$$;
-- All bill_not_part rows of one bill, as user ids in order.
create function pg_temp.np_users(p_tag text) returns uuid[] language sql stable as $$
  select coalesce(array_agg(n.user_id order by n.user_id), '{}')
  from public.bill_not_part as n where n.bill_id = pg_temp.bid(p_tag)
$$;

create function pg_temp.snap(p_user uuid, p_group uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  v := public.group_snapshot(p_group);
  reset role;
  return v;
end $$;

create function pg_temp.keys(p jsonb) returns text[] language sql immutable as $$
  select array_agg(k order by k) from jsonb_object_keys(p) as k
$$;

-- A fingerprint of every shared row of the fixture: bills, line_items, claims,
-- bill_participants, bill_events (by fixture bill), group_events, group_payments, expenses (by
-- fixture group). Any insert, update or delete in them changes it.
create function pg_temp.fixture_bills() returns uuid[] language sql stable as $$
  select array[pg_temp.bid('b0'), pg_temp.bid('b1'), pg_temp.bid('b2'), pg_temp.bid('b3'), pg_temp.bid('b4')]
$$;
create function pg_temp.fingerprint() returns text language sql stable as $$
  select md5(concat_ws('|',
    (select string_agg(t::text, ',' order by t.id) from public.bills as t where t.id = any (pg_temp.fixture_bills())),
    (select string_agg(t::text, ',' order by t.id) from public.line_items as t where t.bill_id = any (pg_temp.fixture_bills())),
    (select string_agg(t::text, ',' order by t.line_item_id, t.user_id) from public.claims as t where t.bill_id = any (pg_temp.fixture_bills())),
    (select string_agg(t::text, ',' order by t.bill_id, t.user_id) from public.bill_participants as t where t.bill_id = any (pg_temp.fixture_bills())),
    (select string_agg(t::text, ',' order by t.id) from public.bill_events as t where t.bill_id = any (pg_temp.fixture_bills())),
    (select string_agg(t::text, ',' order by t.id) from public.group_events as t where t.group_id in (pg_temp.u('a1'), pg_temp.u('a2'))),
    (select string_agg(t::text, ',' order by t.id) from public.group_payments as t where t.group_id in (pg_temp.u('a1'), pg_temp.u('a2'))),
    (select string_agg(t::text, ',' order by t.id) from public.expenses as t where t.group_id in (pg_temp.u('a1'), pg_temp.u('a2')))))
$$;
-- The spec's own form of the check: event counts and the newest group_events seq.
create function pg_temp.event_marks() returns text language sql stable as $$
  select concat_ws('/',
    (select count(*) from public.bill_events as e where e.bill_id = any (pg_temp.fixture_bills())),
    (select count(*) from public.group_events as e where e.group_id in (pg_temp.u('a1'), pg_temp.u('a2'))),
    (select max(e.seq) from public.group_events as e where e.group_id in (pg_temp.u('a1'), pg_temp.u('a2'))))
$$;

-- ---------------------------------------------------------------------------
-- Fixture (through the real functions)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
select pg_temp.u(t.k), 'notpart-' || t.k || '@test.local', jsonb_build_object('full_name', t.n)
from (values ('01','Ana'),('02','Ben'),('03','Cy'),('04','Dee'),('06','Sam')) as t(k, n);

select pg_temp.run(pg_temp.u('01'), format('select public.create_group(%L, %L)', pg_temp.u('a1'), 'Lake trip'));
select pg_temp.run(pg_temp.u('01'), format('select public.create_group(%L, %L)', pg_temp.u('a2'), 'Road trip'));
select pg_temp.run(pg_temp.u('02'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a1'))));
select pg_temp.run(pg_temp.u('03'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a1'))));
select pg_temp.run(pg_temp.u('04'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a1'))));
select pg_temp.run(pg_temp.u('02'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a2'))));

select pg_temp.mk('b1', pg_temp.u('01'), $j$[
  {"name":"Tacos","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1000},
  {"name":"Nachos","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":900},
  {"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":1,"total_cents":500}
]$j$, 2400);
select pg_temp.mk('b3', pg_temp.u('01'), $j$[
  {"name":"Pizza","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":2000},
  {"name":"Soda","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":300}
]$j$, 2300);
select pg_temp.mk('b4', pg_temp.u('01'), $j$[
  {"name":"Wings","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":800}
]$j$, 800);
select pg_temp.mk('b2', pg_temp.u('01'), $j$[
  {"name":"Gas","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":4000}
]$j$, 4000);
select pg_temp.mk('b0', pg_temp.u('01'), $j$[
  {"name":"Solo","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500}
]$j$, 1500, array[pg_temp.u('02')]);

select pg_temp.run(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('b1'), pg_temp.u('a1')));
select pg_temp.run(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('b3'), pg_temp.u('a1')));
select pg_temp.run(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('b4'), pg_temp.u('a1')));
select pg_temp.run(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('b2'), pg_temp.u('a2')));

-- Claims: Ana takes Tacos on B1; Ana splits Pizza on B3 between herself and Cy (assign_item).
select pg_temp.run(pg_temp.u('01'), format('select public.set_claim(%L, true)', pg_temp.li('b1', 'Tacos')));
select pg_temp.run(pg_temp.u('01'), format('select public.assign_item(%L, %L::jsonb, %L::jsonb)',
  pg_temp.li('b3', 'Pizza'), jsonb_build_object(pg_temp.u('01'), 1, pg_temp.u('03'), 1), '{}'));

select pg_temp.run(pg_temp.u('01'), format('select public.add_expense(%L, %L, %L, %L, %s, %L, %L::jsonb)',
  pg_temp.x('e1'), pg_temp.u('a1'), 'Boat', pg_temp.u('01'), 400, 'equal',
  jsonb_build_object(pg_temp.u('01'), 1, pg_temp.u('02'), 1)));

-- Before any set_not_part call.
select set_config('test.fp0', pg_temp.fingerprint(), true);
select set_config('test.ev0', pg_temp.event_marks(), true);
create temp table snaps0 (who text primary key, s jsonb not null);
insert into snaps0 values ('ben_g1', pg_temp.snap(pg_temp.u('02'), pg_temp.u('a1')));

-- ---------------------------------------------------------------------------
-- Criterion 1: the table's privileges
-- ---------------------------------------------------------------------------
select ok((select c.relrowsecurity from pg_class as c where c.oid = 'public.bill_not_part'::regclass),
  'criterion 1: RLS is enabled on bill_not_part');
select ok(
  not exists (
    select 1 from unnest(array['anon', 'authenticated']) as r(role),
                  unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
    where has_table_privilege(r.role, 'public.bill_not_part', p.priv))
  and not exists (
    select 1 from pg_class as c, aclexplode(c.relacl) as a
    where c.oid = 'public.bill_not_part'::regclass and a.grantee = 0),
  'criterion 1: anon and authenticated have no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER; PUBLIC has nothing');
select ok(
  has_column_privilege('authenticated', 'public.bill_not_part', 'bill_id', 'select')
  and has_column_privilege('authenticated', 'public.bill_not_part', 'user_id', 'select')
  and has_column_privilege('authenticated', 'public.bill_not_part', 'created_at', 'select')
  and not has_table_privilege('authenticated', 'public.bill_not_part', 'select')
  and not exists (
    select 1 from information_schema.column_privileges as cp
    where cp.table_schema = 'public' and cp.table_name = 'bill_not_part' and cp.grantee = 'authenticated'
      and cp.privilege_type <> 'SELECT'),
  'criterion 1: authenticated has column SELECT on bill_id, user_id, created_at and nothing else');
select ok(not has_any_column_privilege('anon', 'public.bill_not_part', 'select'),
  'criterion 1: anon has no SELECT on any column');

select throws_ok(
  pg_temp.as_sql(pg_temp.u('02'), format('insert into public.bill_not_part (bill_id, user_id) values (%L, %L)',
    pg_temp.bid('b1'), pg_temp.u('02'))),
  '42501', null, 'criterion 1: a direct insert as authenticated fails 42501');
select pg_temp.run(pg_temp.u('02'), format('select public.set_not_part(%L, true)', pg_temp.bid('b4')));
select throws_ok(
  pg_temp.as_sql(pg_temp.u('02'), format('update public.bill_not_part set created_at = now() where bill_id = %L',
    pg_temp.bid('b4'))),
  '42501', null, 'criterion 1: a direct update of one''s own row as authenticated fails 42501');
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('02'), format('delete from public.bill_not_part where bill_id = %L', pg_temp.bid('b4'))),
  '42501', null, 'criterion 1: a direct delete of one''s own row as authenticated fails 42501');
reset role;
select throws_ok('set local role anon; select bill_id from public.bill_not_part',
  '42501', null, 'criterion 1: select as anon fails 42501');
reset role;
select ok(pg_temp.has_np('b4', pg_temp.u('02')),
  'criterion 1: Ben''s own row survived the refused update and delete');
select pg_temp.run(pg_temp.u('02'), format('select public.set_not_part(%L, false)', pg_temp.bid('b4')));

-- ---------------------------------------------------------------------------
-- The functions and the trigger
-- ---------------------------------------------------------------------------
select ok(
  (select p.prosecdef and p.provolatile = 'v' and p.proconfig @> array['search_path=""']
     and p.prorettype = 'void'::regtype and pg_get_userbyid(p.proowner) = 'postgres'
   from pg_proc as p where p.oid = 'public.set_not_part(uuid, boolean)'::regprocedure),
  'set_not_part is security definer, volatile, search_path = '''', returns void, owned by postgres');
select ok(
  has_function_privilege('authenticated', 'public.set_not_part(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.set_not_part(uuid, boolean)', 'execute')
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.oid = 'public.set_not_part(uuid, boolean)'::regprocedure and a.grantee = 0),
  'criterion 6: set_not_part execute: authenticated, not anon, not PUBLIC');
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres'
     and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute')
   from pg_proc as p where p.oid = 'private.claims_clear_not_part()'::regprocedure),
  'claims_clear_not_part is security definer, search_path = '''', owned by postgres, no client EXECUTE');
select is(
  (select pg_get_triggerdef(t.oid) from pg_trigger as t
   where t.tgrelid = 'public.claims'::regclass and t.tgname = 'claims_clear_not_part'),
  'CREATE TRIGGER claims_clear_not_part AFTER INSERT ON public.claims FOR EACH ROW EXECUTE FUNCTION private.claims_clear_not_part()',
  'the clearing trigger is AFTER INSERT ON claims FOR EACH ROW');
select ok(
  (select position('from public.bill_participants' in s) < position('lock_bill_key_share' in s)
      and position('lock_bill_key_share' in s) < position('for update of bp' in s)
      and position('for update of bp' in s) < position('from public.bills' in s)
      and position('from public.bills' in s) < position('from public.claims' in s)
      and position('from public.claims' in s) < position('insert into public.bill_not_part' in s)
      and position('lock_bill_key_share' in s) < position('delete from public.bill_not_part' in s)
      and position('for update of bp' in s) < position('delete from public.bill_not_part' in s)
   from (select lower(prosrc) as s from pg_proc
         where oid = 'public.set_not_part(uuid, boolean)'::regprocedure) as f),
  'lock order: unlocked participation check, then the bill lock, then the participant row FOR UPDATE, then the group and claims reads, then the write');
select ok(
  (select count(*) = 1 and bool_and(c.confrelid = 'public.bill_participants'::regclass
                                    and c.confdeltype = 'c')
   from pg_constraint as c where c.conrelid = 'public.bill_not_part'::regclass and c.contype = 'f'),
  'criterion 11: the only foreign key is to bill_participants, on delete cascade (none to profiles or auth.users)');

-- ---------------------------------------------------------------------------
-- Criterion 3: opting out, and a repeat
-- ---------------------------------------------------------------------------
select lives_ok(pg_temp.np(pg_temp.u('02'), 'b1', true), 'criterion 3: Ben (no claims) opts out of B1');
reset role;
select is(pg_temp.np_users('b1'), array[pg_temp.u('02')], 'criterion 3: one row, (B1, Ben)');
select lives_ok(pg_temp.np(pg_temp.u('02'), 'b1', true), 'criterion 3: a repeat succeeds');
reset role;
select is(pg_temp.np_users('b1'), array[pg_temp.u('02')], 'criterion 3: still one row after the repeat');

-- ---------------------------------------------------------------------------
-- Criterion 4: has_claims
-- ---------------------------------------------------------------------------
select throws_ok(pg_temp.np(pg_temp.u('01'), 'b1', true), '22023', 'has_claims',
  'criterion 4: Ana, who claimed Tacos, gets 22023 has_claims');
reset role;
select throws_ok(pg_temp.np(pg_temp.u('03'), 'b3', true), '22023', 'has_claims',
  'criterion 4: Cy, on a split row only, gets 22023 has_claims');
reset role;
select ok(not pg_temp.has_np('b1', pg_temp.u('01')) and pg_temp.np_users('b3') = '{}'::uuid[],
  'criterion 4: no row written for Ana on B1 or anyone on B3');

-- ---------------------------------------------------------------------------
-- Criterion 5: a bill outside any group
-- ---------------------------------------------------------------------------
select throws_ok(pg_temp.np(pg_temp.u('02'), 'b0', true), '22023', 'not_in_group',
  'criterion 5: opting out of a bill with no group gets 22023 not_in_group');
reset role;
select ok(not pg_temp.has_np('b0', pg_temp.u('02')), 'criterion 5: no row written on B0');
insert into public.bill_not_part (bill_id, user_id) values (pg_temp.bid('b0'), pg_temp.u('02'));
select lives_ok(pg_temp.np(pg_temp.u('02'), 'b0', false),
  'criterion 5: set_not_part(false) on a non-group bill succeeds for a participant');
reset role;
select ok(not pg_temp.has_np('b0', pg_temp.u('02')),
  'criterion 5: and removes the stale row inserted as superuser');

-- ---------------------------------------------------------------------------
-- Criterion 6: refusals
-- ---------------------------------------------------------------------------
select throws_ok(
  format('set local role authenticated; select set_config(''request.jwt.claims'', null, true); select public.set_not_part(%L, true)',
    pg_temp.bid('b1')),
  '42501', 'not_allowed', 'criterion 6: signed out: 42501 not_allowed');
reset role;
select throws_ok(pg_temp.np(pg_temp.u('06'), 'b1', true), '42501', 'not_allowed',
  'criterion 6: a non-participant (true): 42501 not_allowed');
reset role;
select throws_ok(pg_temp.np(pg_temp.u('06'), 'b1', false), '42501', 'not_allowed',
  'criterion 6: a non-participant (false): 42501 not_allowed');
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), format('select public.set_not_part(%L, true)', pg_temp.x('ff'))),
  '42501', 'not_allowed', 'criterion 6: a bill that doesn''t exist: 42501 not_allowed');
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), 'select public.set_not_part(null, true)'),
  '42501', 'not_allowed', 'criterion 6: a null bill id: 42501 not_allowed');
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), format('select public.set_not_part(%L, null)', pg_temp.bid('b1'))),
  '42501', 'not_allowed', 'criterion 6: a null p_not_part: 42501 not_allowed');
reset role;
select throws_ok(format('set local role anon; select public.set_not_part(%L, true)', pg_temp.bid('b1')),
  '42501', null, 'criterion 6: anon has no execute: 42501');
reset role;
select is(pg_temp.np_users('b1'), array[pg_temp.u('02')], 'criterion 6: the refusals wrote nothing on B1');

-- ---------------------------------------------------------------------------
-- Criterion 7: undo deletes only the caller's row
-- ---------------------------------------------------------------------------
select lives_ok(pg_temp.np(pg_temp.u('03'), 'b1', true), 'criterion 7: Cy (no claims on B1) opts out too');
reset role;
select is(pg_temp.np_users('b1'), array[pg_temp.u('02'), pg_temp.u('03')], 'criterion 7: B1 has Ben''s and Cy''s rows');
select lives_ok(pg_temp.np(pg_temp.u('02'), 'b1', false), 'criterion 7: Ben undoes');
reset role;
select is(pg_temp.np_users('b1'), array[pg_temp.u('03')], 'criterion 7: only Ben''s row went; Cy''s stays');
select lives_ok(pg_temp.np(pg_temp.u('02'), 'b1', false), 'criterion 7: undo with no row is still a success');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 2: reading
-- ---------------------------------------------------------------------------
select pg_temp.run(pg_temp.u('02'), format('select public.set_not_part(%L, true)', pg_temp.bid('b1')));
select pg_temp.run(pg_temp.u('02'), format('select public.set_not_part(%L, true)', pg_temp.bid('b3')));
select pg_temp.run(pg_temp.u('02'), format('select public.set_not_part(%L, true)', pg_temp.bid('b2')));

select is(pg_temp.np_users('b1'), array[pg_temp.u('02'), pg_temp.u('03')],
  'criterion 2: positive control: as superuser, B1 holds Ben''s and Cy''s rows');
create function pg_temp.read_as(p_user uuid) returns text[] language plpgsql as $$
declare v text[];
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  select coalesce(array_agg(n.bill_id::text || ':' || n.user_id::text order by n.bill_id), '{}')
  into v
  from public.bill_not_part as n
  where n.bill_id = any (pg_temp.fixture_bills());
  reset role;
  return v;
end $$;
select is(pg_temp.read_as(pg_temp.u('02')),
  (select array_agg(t.b::text || ':' || pg_temp.u('02')::text order by t.b)
   from unnest(array[pg_temp.bid('b1'), pg_temp.bid('b2'), pg_temp.bid('b3')]) as t(b)),
  'criterion 2: as Ben, select returns exactly his three rows (not Cy''s row on B1)');
select is(pg_temp.read_as(pg_temp.u('03')),
  array[pg_temp.bid('b1')::text || ':' || pg_temp.u('03')::text],
  'criterion 2: as Cy, only Cy''s row');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('02'), format('select * from public.bill_not_part where bill_id = %L', pg_temp.bid('b1'))),
  'select * works for authenticated (no hidden columns on this table)');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 9: nothing shared changed (every set_not_part call above, both ways)
-- ---------------------------------------------------------------------------
select is(pg_temp.fingerprint(), current_setting('test.fp0'),
  'criterion 9: no row of bills, line_items, claims, bill_participants, bill_events, group_events, group_payments or expenses changed');
select is(pg_temp.event_marks(), current_setting('test.ev0'),
  'criterion 9: bill_events and group_events counts and the newest group_events seq are unchanged');

-- ---------------------------------------------------------------------------
-- Criterion 10: the snapshot's me.not_part_bill_ids
-- ---------------------------------------------------------------------------
create temp table snaps (who text primary key, s jsonb not null);
insert into snaps values
  ('ana_g1', pg_temp.snap(pg_temp.u('01'), pg_temp.u('a1'))),
  ('ben_g1', pg_temp.snap(pg_temp.u('02'), pg_temp.u('a1'))),
  ('cy_g1',  pg_temp.snap(pg_temp.u('03'), pg_temp.u('a1'))),
  ('ben_g2', pg_temp.snap(pg_temp.u('02'), pg_temp.u('a2')));
create function pg_temp.s(p_who text) returns jsonb language sql stable as
  $$ select s from snaps where who = p_who $$;

select is(pg_temp.s('ben_g1') -> 'me',
  jsonb_build_object('hidden', false, 'not_part_bill_ids',
    (select jsonb_agg(t.b order by t.b) from unnest(array[pg_temp.bid('b1'), pg_temp.bid('b3')]) as t(b))),
  'criterion 10: Ben''s G1 me = hidden false, his two G1 opt-outs ordered by bill_id (not G2''s B2)');
select is(pg_temp.s('ana_g1') -> 'me', '{"hidden": false, "not_part_bill_ids": []}'::jsonb,
  'criterion 10: Ana (no opt-outs) gets [], never Ben''s or Cy''s ids');
select is(pg_temp.s('cy_g1') -> 'me', jsonb_build_object('hidden', false, 'not_part_bill_ids', jsonb_build_array(pg_temp.bid('b1'))),
  'criterion 10: Cy gets only her own opt-out');
select is(pg_temp.s('ben_g2') -> 'me', jsonb_build_object('hidden', false, 'not_part_bill_ids', jsonb_build_array(pg_temp.bid('b2'))),
  'criterion 10: the G2 opt-out shows only in G2''s snapshot');
select is(pg_temp.keys(pg_temp.s('ben_g1')),
  array['bills','expenses','group','me','members','money_fingerprint','not_received','payments'],
  'criterion 10: the top-level keys are unchanged (plus money_fingerprint, delete group)');
select is(pg_temp.s('ben_g1') - 'me', (select s from snaps0 where who = 'ben_g1') - 'me',
  'criterion 10: every key but me is identical before and after the opt-outs');

-- ---------------------------------------------------------------------------
-- Criterion 8: a claim for the person clears their row (three ways)
-- ---------------------------------------------------------------------------
select pg_temp.run(pg_temp.u('02'), format('select public.set_not_part(%L, true)', pg_temp.bid('b4')));
select pg_temp.run(pg_temp.u('04'), format('select public.set_not_part(%L, true)', pg_temp.bid(t.b)))
from unnest(array['b1', 'b3', 'b4']) as t(b);
select ok(
  pg_temp.has_np('b1', pg_temp.u('02')) and pg_temp.has_np('b3', pg_temp.u('02')) and pg_temp.has_np('b4', pg_temp.u('02'))
  and pg_temp.has_np('b1', pg_temp.u('04')) and pg_temp.has_np('b3', pg_temp.u('04')) and pg_temp.has_np('b4', pg_temp.u('04')),
  'criterion 8: positive control: Ben and Dee have rows on B1, B3 and B4');

select lives_ok(pg_temp.as_sql(pg_temp.u('02'), format('select public.set_claim(%L, true)', pg_temp.li('b1', 'Nachos'))),
  'criterion 8: Ben''s own set_claim on B1 succeeds');
reset role;
select ok(not pg_temp.has_np('b1', pg_temp.u('02')), 'criterion 8: set_claim deleted Ben''s B1 row');

select lives_ok(pg_temp.as_sql(pg_temp.u('01'), format('select public.assign_item(%L, %L::jsonb, %L::jsonb)',
    pg_temp.li('b3', 'Soda'), jsonb_build_object(pg_temp.u('02'), 1), '{}')),
  'criterion 8: Ana''s assign_item giving Ben Soda on B3 succeeds');
reset role;
select ok(not pg_temp.has_np('b3', pg_temp.u('02')), 'criterion 8: assign_item deleted Ben''s B3 row');

select lives_ok(
  format('select set_config(''request.jwt.claims'', null, true); set local role service_role; insert into public.claims (bill_id, line_item_id, user_id) values (%L, %L, %L)',
    pg_temp.bid('b4'), pg_temp.li('b4', 'Wings'), pg_temp.u('02')),
  'criterion 8: a direct insert into claims as service_role succeeds');
reset role;
select ok(not pg_temp.has_np('b4', pg_temp.u('02')), 'criterion 8: the service_role insert deleted Ben''s B4 row');

select ok(pg_temp.has_np('b1', pg_temp.u('04')) and pg_temp.has_np('b3', pg_temp.u('04')) and pg_temp.has_np('b4', pg_temp.u('04'))
    and pg_temp.has_np('b1', pg_temp.u('03')),
  'criterion 8: Dee''s rows on B1, B3, B4 and Cy''s on B1 are untouched');
select throws_ok(pg_temp.np(pg_temp.u('02'), 'b1', true), '22023', 'has_claims',
  'criterion 8: after the claim, Ben can''t opt out of B1 again');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 11: cascades
-- ---------------------------------------------------------------------------
insert into public.bill_not_part (bill_id, user_id) values (pg_temp.bid('b0'), pg_temp.u('02'));
delete from public.bill_participants where bill_id = pg_temp.bid('b0') and user_id = pg_temp.u('02');
select ok(not pg_temp.has_np('b0', pg_temp.u('02')),
  'criterion 11: deleting Ben''s participant row deletes his bill_not_part row');
delete from public.bills where id = pg_temp.bid('b4');
select is(
  (select count(*)::integer from public.bill_not_part where bill_id = pg_temp.bid('b4')), 0,
  'criterion 11: deleting the bill deletes its bill_not_part rows (Dee''s on B4)');

select * from finish();
rollback;
