-- pgTAP tests for the Groups T6 migration (20261127061004_group_snapshot.sql; spec
-- docs/specs/2026-11-26-groups-mvp.md C-G11 as amended by A1.7, A2.1 and GR-M6; criteria 35, 36,
-- 104). The shape asserted here is the one lib/groups.ts's parseSnapshot reads.
--
-- Every assertion filters to the fixture users / groups / bills below (the local DB may hold real
-- data). Fixture user ids start with e7000000.
-- Users: Ana ..01 (creates G1 and G3, hosts B1, B2 and the non-group bill B0), Ben ..02, Cy ..03
--   (hides G1), Lee ..05 (joins G1, then leaves), Sam ..06 (stranger to G1; G2 with bill BS).
-- Groups: G1 ..a1 'Tahoe trip' (Ana, Ben, Cy), G2 ..a2 (Sam), G3 ..a3 (Ana only, empty).
-- B1 rows (group_position.unit_index): 0.0 Tacos 1200 (Ben 2 parts, Cy 1), 1.0 Beer 700 (Ana),
--   1.1 Beer 700 (unclaimed), 2.0 Nachos 900, 3.0 Water 0, 4.0 Happy hour -200 discount.
-- Expenses: E1 100 equal (34/33/33), E2 1 equal (1/0/0, $0 rows), E3 deleted.
-- Payments: P1 Ben->Ana 500 cash manual (live), P5 Cy->Ben 200 other manual (live, older),
--   P2 Cy->Ana 300 venmo venmo_link (undone by Cy, 'sender'), P3 Ben->Ana 700 (undone by Ana,
--   'not_received'), P4 Ben->Ana 800 (not_received, 31 days ago).

begin;

create extension if not exists pgtap with schema extensions;

select plan(46);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('e7000000-0000-0000-0000-0000000000' || p)::uuid
$$;
create function pg_temp.x(p text) returns uuid language sql immutable as $$
  select ('e7000000-0000-0000-0002-0000000000' || p)::uuid
$$;

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.as_sql(p_user uuid, p_sql text) returns text language sql immutable as $$
  select format(
    'select set_config(''request.jwt.claims'', %L, true); set local role authenticated; %s',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, p_sql)
$$;

create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.bill_' || p_tag)::uuid $$;
create function pg_temp.row_id(p_tag text, p_pos integer, p_unit integer) returns uuid
language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.group_position = p_pos and li.unit_index = p_unit
$$;
create function pg_temp.gcode(p_group uuid) returns text language sql stable as
  $$ select g.join_code from public.groups as g where g.id = p_group $$;

-- Run p_sql as p_user (authenticated), then return to the test's role.
create function pg_temp.run(p_user uuid, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  execute p_sql;
  reset role;
end $$;

create function pg_temp.mk(p_tag text, p_host uuid, p_rows jsonb, p_total integer) returns void
language plpgsql as $$
declare r record;
begin
  perform pg_temp.act(p_host);
  set local role authenticated;
  select * into r from public.create_bill(p_rows, null, 0, 0, 0, 0, 0, p_total);
  reset role;
  perform set_config('test.bill_' || p_tag, r.bill_id::text, true);
end $$;

create function pg_temp.snap(p_user uuid, p_group uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  v := public.group_snapshot(p_group);
  reset role;
  return v;
end $$;

-- The keys of a jsonb object, sorted.
create function pg_temp.keys(p jsonb) returns text[] language sql immutable as $$
  select array_agg(k order by k) from jsonb_object_keys(p) as k
$$;
-- Every element of a jsonb array has exactly these keys (true for an empty array).
create function pg_temp.all_keys(p jsonb, p_keys text[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(pg_temp.keys(e) = (select array_agg(k order by k) from unnest(p_keys) as k)), true)
  from jsonb_array_elements(p) as e
$$;
-- The given field of every element, in order, as text.
create function pg_temp.col(p jsonb, p_key text) returns text[] language sql immutable as $$
  select coalesce(array_agg(e ->> p_key order by o), '{}') from jsonb_array_elements(p) with ordinality as t(e, o)
$$;

-- ---------------------------------------------------------------------------
-- Fixture (through the real functions)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
select pg_temp.u(t.k), 'gsnap-' || t.k || '@test.local', jsonb_build_object('full_name', t.n)
from (values ('01','Ana'),('02','Ben'),('03','Cy'),('05','Lee'),('06','Sam')) as t(k, n);
update public.profiles set venmo_username = 'ben-venmo' where id = pg_temp.u('02');

select pg_temp.run(pg_temp.u('01'), format('select public.create_group(%L, %L)', pg_temp.u('a1'), 'Tahoe trip'));
select pg_temp.run(pg_temp.u('01'), format('select public.create_group(%L, %L)', pg_temp.u('a3'), 'Empty'));
select pg_temp.run(pg_temp.u('06'), format('select public.create_group(%L, %L)', pg_temp.u('a2'), 'Sam trip'));
select pg_temp.run(pg_temp.u('02'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a1'))));
select pg_temp.run(pg_temp.u('03'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a1'))));
select pg_temp.run(pg_temp.u('05'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.u('a1'))));

select pg_temp.mk('b1', pg_temp.u('01'), $j$[
  {"name":"Tacos","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1200},
  {"name":"Beer","note":null,"group_position":1,"unit_index":0,"group_size":2,"total_cents":700},
  {"name":"Beer","note":null,"group_position":1,"unit_index":1,"group_size":2,"total_cents":700},
  {"name":"Nachos","note":null,"group_position":2,"unit_index":0,"group_size":1,"total_cents":900},
  {"name":"Water","note":null,"group_position":3,"unit_index":0,"group_size":1,"total_cents":0},
  {"name":"Happy hour","note":null,"group_position":4,"unit_index":0,"group_size":1,"total_cents":-200,
   "kind":"discount","applies_to":"subtotal"}
]$j$, 3300);
select pg_temp.mk('b2', pg_temp.u('01'), $j$[
  {"name":"Gas","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":4000}
]$j$, 4000);
select pg_temp.mk('b0', pg_temp.u('01'), $j$[
  {"name":"Solo lunch","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500}
]$j$, 1500);
select pg_temp.mk('bs', pg_temp.u('06'), $j$[
  {"name":"Sam pizza","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":2000}
]$j$, 2000);

select pg_temp.run(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('b1'), pg_temp.u('a1')));
select pg_temp.run(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('b2'), pg_temp.u('a1')));
select pg_temp.run(pg_temp.u('06'), format('select public.attach_bill_to_group(%L, %L)', pg_temp.bid('bs'), pg_temp.u('a2')));

-- Claims: Tacos shared Ben 2 / Cy 1; Ana takes the first Beer.
select pg_temp.run(pg_temp.u('02'), format('select public.set_claim(%L, true)', pg_temp.row_id('b1', 0, 0)));
select pg_temp.run(pg_temp.u('03'), format('select public.set_claim(%L, true)', pg_temp.row_id('b1', 0, 0)));
select pg_temp.run(pg_temp.u('02'), format('select public.set_item_split(%L, %L::jsonb)', pg_temp.row_id('b1', 0, 0),
  jsonb_build_object(pg_temp.u('02'), 2, pg_temp.u('03'), 1)));
select pg_temp.run(pg_temp.u('01'), format('select public.set_claim(%L, true)', pg_temp.row_id('b1', 1, 0)));

-- Lee leaves (no history).
select pg_temp.run(pg_temp.u('05'), format('select public.leave_group(%L)', pg_temp.u('a1')));

-- Expenses (Ana pays; equal among Ana, Ben, Cy).
select pg_temp.run(pg_temp.u('01'), format('select public.add_expense(%L, %L, %L, %L, %s, %L, %L::jsonb)',
  pg_temp.x('e1'), pg_temp.u('a1'), 'Airbnb', pg_temp.u('01'), 100, 'equal',
  jsonb_build_object(pg_temp.u('01'), 1, pg_temp.u('02'), 1, pg_temp.u('03'), 1)));
select pg_temp.run(pg_temp.u('01'), format('select public.add_expense(%L, %L, %L, %L, %s, %L, %L::jsonb)',
  pg_temp.x('e2'), pg_temp.u('a1'), 'Gum', pg_temp.u('01'), 1, 'equal',
  jsonb_build_object(pg_temp.u('01'), 1, pg_temp.u('02'), 1, pg_temp.u('03'), 1)));
select pg_temp.run(pg_temp.u('01'), format('select public.add_expense(%L, %L, %L, %L, %s, %L, %L::jsonb)',
  pg_temp.x('e3'), pg_temp.u('a1'), 'Mistake', pg_temp.u('01'), 50, 'equal',
  jsonb_build_object(pg_temp.u('01'), 1, pg_temp.u('02'), 1)));
select pg_temp.run(pg_temp.u('01'), format('select public.delete_expense(%L, 1)', pg_temp.x('e3')));

-- Payments.
select pg_temp.run(pg_temp.u('02'), format('select public.record_payment(%L, %L, %L, %L, 500, %L, %L)',
  pg_temp.x('c1'), pg_temp.u('a1'), pg_temp.u('02'), pg_temp.u('01'), 'cash', 'manual'));
select pg_temp.run(pg_temp.u('03'), format('select public.record_payment(%L, %L, %L, %L, 200, %L, %L)',
  pg_temp.x('c5'), pg_temp.u('a1'), pg_temp.u('03'), pg_temp.u('02'), 'other', 'manual'));
select pg_temp.run(pg_temp.u('03'), format('select public.record_payment(%L, %L, %L, %L, 300, %L, %L)',
  pg_temp.x('c2'), pg_temp.u('a1'), pg_temp.u('03'), pg_temp.u('01'), 'venmo', 'venmo_link'));
select pg_temp.run(pg_temp.u('03'), format('select public.undo_payment(%L)', pg_temp.x('c2')));
select pg_temp.run(pg_temp.u('02'), format('select public.record_payment(%L, %L, %L, %L, 700, %L, %L)',
  pg_temp.x('c3'), pg_temp.u('a1'), pg_temp.u('02'), pg_temp.u('01'), 'cash', 'manual'));
select pg_temp.run(pg_temp.u('01'), format('select public.undo_payment(%L)', pg_temp.x('c3')));
select pg_temp.run(pg_temp.u('02'), format('select public.record_payment(%L, %L, %L, %L, 800, %L, %L)',
  pg_temp.x('c4'), pg_temp.u('a1'), pg_temp.u('02'), pg_temp.u('01'), 'cash', 'manual'));
select pg_temp.run(pg_temp.u('01'), format('select public.undo_payment(%L)', pg_temp.x('c4')));

-- Cy hides G1.
select pg_temp.run(pg_temp.u('03'), format('select public.set_group_hidden(%L, true)', pg_temp.u('a1')));

-- Distinct times so the orders are tested (everything above shares one now()).
update public.group_members set joined_at = now() + interval '2 minutes'
where group_id = pg_temp.u('a1') and user_id = pg_temp.u('02');
update public.group_members set joined_at = now() + interval '1 minute'
where group_id = pg_temp.u('a1') and user_id = pg_temp.u('03');
update public.bills set created_at = now() - interval '1 hour' where id = pg_temp.bid('b1');
update public.bills set created_at = now() - interval '2 hours' where id = pg_temp.bid('b2');
update public.expenses set created_at = now() - interval '1 hour' where id = pg_temp.x('e2');
update public.group_payments set created_at = now() - interval '1 hour' where id = pg_temp.x('c5');
update public.group_payments set undone_at = now() - interval '31 days', created_at = now() - interval '32 days'
where id = pg_temp.x('c4');

select set_config('test.events_before', (select count(*)::text from public.group_events
  where group_id = pg_temp.u('a1')), true);

create temp table snaps (who text primary key, s jsonb not null);
insert into snaps values
  ('ana', pg_temp.snap(pg_temp.u('01'), pg_temp.u('a1'))),
  ('ben', pg_temp.snap(pg_temp.u('02'), pg_temp.u('a1'))),
  ('cy',  pg_temp.snap(pg_temp.u('03'), pg_temp.u('a1'))),
  ('empty', pg_temp.snap(pg_temp.u('01'), pg_temp.u('a3')));
create function pg_temp.s(p_who text) returns jsonb language sql stable as
  $$ select s from snaps where who = p_who $$;
create function pg_temp.bill(p_who text, p_tag text) returns jsonb language sql stable as $$
  select e from jsonb_array_elements(pg_temp.s(p_who) -> 'bills') as e
  where e ->> 'id' = pg_temp.bid(p_tag)::text
$$;

-- ---------------------------------------------------------------------------
-- The function itself
-- ---------------------------------------------------------------------------
select ok(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""']
     and p.prorettype = 'jsonb'::regtype
   from pg_proc as p where p.oid = 'public.group_snapshot(uuid)'::regprocedure),
  'group_snapshot is security definer, stable, search_path = '''', returns jsonb');
select ok(
  has_function_privilege('authenticated', 'public.group_snapshot(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.group_snapshot(uuid)', 'execute')
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.oid = 'public.group_snapshot(uuid)'::regprocedure and a.grantee = 0),
  'execute: authenticated only (not anon, not PUBLIC)');
select ok(
  (select lower(prosrc) !~ 'for (update|share|no key update|key share)'
   from pg_proc where oid = 'public.group_snapshot(uuid)'::regprocedure),
  'group_snapshot takes no row locks (adds no path to the lock order)');

-- ---------------------------------------------------------------------------
-- Criterion 35: keys and orders
-- ---------------------------------------------------------------------------
select is(pg_temp.keys(pg_temp.s('ana')),
  array['bills','expenses','group','me','members','money_fingerprint','not_received','payments'],
  'top-level keys are exactly the C-G11 keys plus not_received (GR-M6) and money_fingerprint (delete group)');

select is(pg_temp.s('ana') -> 'group',
  (select jsonb_build_object('id', g.id, 'name', g.name, 'join_code', g.join_code,
     'created_by', g.created_by, 'created_at', g.created_at)
   from public.groups as g where g.id = pg_temp.u('a1')),
  'group: id, name, join_code, created_by, created_at');

-- Group claim status C4: me also carries not_part_bill_ids ([] here; the opt-out cases are in
-- bill_not_part.test.sql, criterion 10).
select is(pg_temp.s('ana') -> 'me', '{"hidden": false, "not_part_bill_ids": []}'::jsonb, 'me.hidden is false for Ana');
select is(pg_temp.s('cy') -> 'me', '{"hidden": true, "not_part_bill_ids": []}'::jsonb, 'me.hidden is true for Cy, who hid it');
select is(pg_temp.s('cy') -> 'bills', pg_temp.s('ana') -> 'bills', 'a hidden group still returns its data');

select is(pg_temp.col(pg_temp.s('ana') -> 'members', 'user_id'),
  array[pg_temp.u('01'), pg_temp.u('03'), pg_temp.u('02')]::text[],
  'members ordered by joined_at, user_id (Lee, who left, is absent)');
select ok(pg_temp.all_keys(pg_temp.s('ana') -> 'members', array['user_id','display_name','venmo_username','joined_at']),
  'each member has exactly user_id, display_name, venmo_username, joined_at');
select is(
  (select e from jsonb_array_elements(pg_temp.s('ana') -> 'members') as e where e ->> 'user_id' = pg_temp.u('02')::text)
    - 'joined_at',
  jsonb_build_object('user_id', pg_temp.u('02'), 'display_name',
    (select display_name from public.profiles where id = pg_temp.u('02')), 'venmo_username', 'ben-venmo'),
  'a member''s display_name and venmo_username come from profiles');

select is(pg_temp.col(pg_temp.s('ana') -> 'bills', 'id'),
  array[pg_temp.bid('b2'), pg_temp.bid('b1')]::text[],
  'bills: only the group''s, ordered by created_at, id');
select ok(pg_temp.all_keys(pg_temp.s('ana') -> 'bills',
    array['id','host_id','payer_id','total_cents','extras_split','created_at','rows','participant_ids']),
  'each bill has exactly the C-G11 keys (no bill-level claims, A1.7)');
select is(pg_temp.bill('ana', 'b1') - 'rows' - 'participant_ids' - 'created_at',
  (select jsonb_build_object('id', b.id, 'host_id', b.host_id, 'payer_id', b.payer_id,
     'total_cents', b.total_cents, 'extras_split', b.extras_split)
   from public.bills as b where b.id = pg_temp.bid('b1')),
  'B1''s scalar fields match the bill row');
select is((pg_temp.bill('ana', 'b1') -> 'total_cents')::text, '3300', 'B1 total_cents is a JSON integer');
select is(pg_temp.bill('ana', 'b1') -> 'participant_ids',
  jsonb_build_array(pg_temp.u('01'), pg_temp.u('02'), pg_temp.u('03')),
  'participant_ids = the members, ordered by user_id');

select is(pg_temp.col(pg_temp.bill('ana', 'b1') -> 'rows', 'id'),
  array[pg_temp.row_id('b1',0,0), pg_temp.row_id('b1',1,0), pg_temp.row_id('b1',1,1),
        pg_temp.row_id('b1',2,0), pg_temp.row_id('b1',3,0), pg_temp.row_id('b1',4,0)]::text[],
  'rows ordered by group_position, unit_index');
select ok(pg_temp.all_keys(pg_temp.bill('ana', 'b1') -> 'rows', array['id','total_cents','kind','name','claims'])
    and pg_temp.all_keys(pg_temp.bill('ana', 'b2') -> 'rows', array['id','total_cents','kind','name','claims']),
  'criterion 104: each row has exactly id, total_cents, kind, name, claims (no group_position / unit_index)');
select is(pg_temp.col(pg_temp.bill('ana', 'b1') -> 'rows', 'name'),
  array[null, null, 'Beer', 'Nachos', 'Water', 'Happy hour']::text[],
  'criterion 104: name is null on every claimed row and present on every unclaimed row');
select is(pg_temp.bill('ana', 'b1') -> 'rows' -> 0 -> 'claims',
  jsonb_build_object(pg_temp.u('02'), 2, pg_temp.u('03'), 1),
  'claims are nested per row as {"<uid>": parts}');
select is(pg_temp.bill('ana', 'b1') -> 'rows' -> 1 -> 'claims',
  jsonb_build_object(pg_temp.u('01'), 1), 'a one-claimer row');
select is(pg_temp.bill('ana', 'b1') -> 'rows' -> 3 -> 'claims', '{}'::jsonb, 'an unclaimed row has claims {}');
select is(pg_temp.bill('ana', 'b1') -> 'rows' -> 5,
  jsonb_build_object('id', pg_temp.row_id('b1',4,0), 'total_cents', -200, 'kind', 'discount',
    'name', 'Happy hour', 'claims', '{}'::jsonb),
  'a discount row: kind discount, negative total_cents');
select is(pg_temp.bill('ana', 'b1') -> 'rows' -> 4 -> 'total_cents', '0'::jsonb, 'a $0 row is present with 0');

select is(pg_temp.col(pg_temp.s('ana') -> 'expenses', 'id'),
  array[pg_temp.x('e2'), pg_temp.x('e1')]::text[],
  'expenses: live only (deleted E3 absent), ordered by created_at, id');
select ok(pg_temp.all_keys(pg_temp.s('ana') -> 'expenses',
    array['id','title','payer_id','amount_cents','split_method','created_by','created_at','edited_at','version','shares']),
  'each expense has exactly the C-G11 keys');
select is(
  (select e - 'created_at' from jsonb_array_elements(pg_temp.s('ana') -> 'expenses') as e where e ->> 'id' = pg_temp.x('e2')::text),
  jsonb_build_object('id', pg_temp.x('e2'), 'title', 'Gum', 'payer_id', pg_temp.u('01'), 'amount_cents', 1,
    'split_method', 'equal', 'created_by', pg_temp.u('01'), 'edited_at', null, 'version', 1,
    'shares', jsonb_build_array(
      jsonb_build_object('user_id', pg_temp.u('01'), 'cents', 1),
      jsonb_build_object('user_id', pg_temp.u('02'), 'cents', 0),
      jsonb_build_object('user_id', pg_temp.u('03'), 'cents', 0))),
  'E2: every field, and shares include the $0 rows, ordered by user_id');
select is(
  (select e -> 'shares' from jsonb_array_elements(pg_temp.s('ana') -> 'expenses') as e where e ->> 'id' = pg_temp.x('e1')::text),
  jsonb_build_array(
    jsonb_build_object('user_id', pg_temp.u('01'), 'cents', 34),
    jsonb_build_object('user_id', pg_temp.u('02'), 'cents', 33),
    jsonb_build_object('user_id', pg_temp.u('03'), 'cents', 33)),
  'E1 shares 34/33/33');

select is(pg_temp.col(pg_temp.s('ana') -> 'payments', 'id'),
  array[pg_temp.x('c5'), pg_temp.x('c1')]::text[],
  'payments: live only (undone P2, P3, P4 absent), ordered by created_at, id');
select ok(pg_temp.all_keys(pg_temp.s('ana') -> 'payments',
    array['id','from_user','to_user','cents','method','source','recorded_by','bill_id','created_at']),
  'each payment has exactly id, from_user, to_user, cents, method, source, recorded_by, bill_id, created_at');
select is(
  (select e - 'created_at' from jsonb_array_elements(pg_temp.s('ana') -> 'payments') as e where e ->> 'id' = pg_temp.x('c1')::text),
  jsonb_build_object('id', pg_temp.x('c1'), 'from_user', pg_temp.u('02'), 'to_user', pg_temp.u('01'),
    'cents', 500, 'method', 'cash', 'source', 'manual', 'recorded_by', pg_temp.u('02'), 'bill_id', null),
  'P1: every field (method and source, A2.1)');

-- GR-M6: not_received
select is(pg_temp.s('ana') -> 'not_received',
  (select jsonb_build_array(jsonb_build_object('id', gp.id, 'from', gp.from_user, 'to', gp.to_user,
     'cents', gp.cents, 'method', gp.method, 'undone_at', gp.undone_at))
   from public.group_payments as gp where gp.id = pg_temp.x('c3')),
  'not_received for the recipient: P3 only (sender-undone P2 and 31-day-old P4 absent), exact keys');
select is(pg_temp.s('ben') -> 'not_received', pg_temp.s('ana') -> 'not_received',
  'not_received for the sender: the same P3');
select is(pg_temp.s('cy') -> 'not_received', '[]'::jsonb,
  'not_received is [] for a member who is neither side');
select ok((pg_temp.s('ana') -> 'not_received' -> 0 ->> 'undone_at')
    ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$',
  'undone_at is ISO 8601 with an offset (the parser''s format)');

-- Empty group: every array present and empty.
select is(pg_temp.s('empty') - 'group' - 'me' - 'members' - 'money_fingerprint',
  '{"bills": [], "expenses": [], "payments": [], "not_received": []}'::jsonb,
  'an empty group returns [] for bills, expenses, payments, not_received');

-- ---------------------------------------------------------------------------
-- Criterion 36: nothing from outside the group, no email
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(position(t in pg_temp.s('ana')::text) = 0)
   from unnest(array[pg_temp.u('05')::text, pg_temp.u('06')::text, pg_temp.u('a2')::text,
                     pg_temp.bid('b0')::text, pg_temp.bid('bs')::text]) as t),
  'no id of a non-member (Lee who left, Sam), of another group or of a bill outside the group');
select ok(position('@' in pg_temp.s('ana')::text) = 0 and position('email' in pg_temp.s('ana')::text) = 0,
  'no email address and no email key');
select ok(
  (select count(*) > 0 and bool_and(m[1] = lower(m[1]))
   from regexp_matches(pg_temp.s('ana')::text,
     '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'g') as m),
  'every uuid in the payload is lowercase canonical');
select is(
  (select count(*)::text from public.group_events where group_id = pg_temp.u('a1')),
  current_setting('test.events_before'),
  'reading the snapshot logs no event');

-- ---------------------------------------------------------------------------
-- Refusals: 42501 for everyone who isn't a member
-- ---------------------------------------------------------------------------
select throws_ok(pg_temp.as_sql(pg_temp.u('06'), format('select public.group_snapshot(%L)', pg_temp.u('a1'))),
  '42501', 'not_allowed', 'a non-member gets 42501 not_allowed');
select throws_ok(pg_temp.as_sql(pg_temp.u('05'), format('select public.group_snapshot(%L)', pg_temp.u('a1'))),
  '42501', 'not_allowed', 'a member who left gets 42501 not_allowed');
select throws_ok(pg_temp.as_sql(pg_temp.u('01'), format('select public.group_snapshot(%L)', pg_temp.x('ff'))),
  '42501', 'not_allowed', 'a group that doesn''t exist: 42501 not_allowed');
select throws_ok(pg_temp.as_sql(pg_temp.u('01'), 'select public.group_snapshot(null)'),
  '42501', 'not_allowed', 'a null group id: 42501 not_allowed');
select throws_ok(
  format('set local role authenticated; select set_config(''request.jwt.claims'', null, true); select public.group_snapshot(%L)', pg_temp.u('a1')),
  '42501', 'not_allowed', 'authenticated without a user id: 42501 not_allowed');
select throws_ok(format('set local role anon; select public.group_snapshot(%L)', pg_temp.u('a1')),
  '42501', null, 'anon has no execute: 42501');

select * from finish();
rollback;
