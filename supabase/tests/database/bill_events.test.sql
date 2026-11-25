-- pgTAP tests for the Activity log: bill_events and its writers (spec
-- 2026-11-20-m1b-m2-share-and-claim.md, Task 15, criteria 119-131; A1.6, A2.3, A3).
-- details shapes are the ones lib/activityText.ts parses.
--
-- Users: H a1... 'Hana' (host of X), P a2... 'Pat', R a5... 'Rae' (participants of X),
--        O a3... 'Oli' (host of Y, outsider to X), Q a4... 'Quinn' (participant of Y).
-- Bill X: Burger 1500, Fries 600, Beer x2 (700/700), Soda 300; tax 280, tip 700, total 4780.

begin;

create extension if not exists pgtap with schema extensions;

select plan(74);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('a4000000-0000-0000-0000-000000000004', 'q@test.local', '{"full_name":"Quinn"}'::jsonb),
  ('a5000000-0000-0000-0000-000000000005', 'r@test.local', '{"full_name":"Rae"}'::jsonb);

-- Shorthand used below (as postgres): the events of a bill of a given kind.
create temp view x_events as
  select e.* from public.bill_events e where e.bill_id = current_setting('test.x_id', true)::uuid;

-- ---------------------------------------------------------------------------
-- Criterion 119: RLS, grants, columns. Criterion 130: no email column.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.bill_events'::regclass),
  'criterion 119: RLS is enabled on bill_events');
select table_privs_are('public', 'bill_events', 'anon', array[]::text[],
  'criterion 119: anon has no privileges on bill_events');
select table_privs_are('public', 'bill_events', 'authenticated', array['SELECT'],
  'criterion 119: authenticated has SELECT only on bill_events');
select columns_are('public', 'bill_events',
  array['id', 'bill_id', 'actor_id', 'kind', 'item_name', 'details', 'created_at'],
  'bill_events has exactly the spec''d columns');
select hasnt_column('public', 'bill_events', 'email', 'criterion 130: bill_events has no email column');
select has_index('public', 'bill_events', 'bill_events_bill_id_created_at_idx', array['bill_id', 'created_at'],
  'index on (bill_id, created_at desc)');
select ok(
  (select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'bill_events'
     and cmd = 'SELECT' and roles = '{authenticated}')
  and (select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'bill_events'),
  'bill_events has one policy: SELECT for authenticated (no write policies)');

-- ---------------------------------------------------------------------------
-- Criterion 123: log_event and the trigger functions
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
     where oid = 'private.log_event(uuid,uuid,text,text,jsonb)'::regprocedure),
  'criterion 123: private.log_event is security definer with an empty search_path');
select ok(
  not has_function_privilege('anon', 'private.log_event(uuid,uuid,text,text,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_event(uuid,uuid,text,text,jsonb)', 'execute')
  and not has_function_privilege('public', 'private.log_event(uuid,uuid,text,text,jsonb)', 'execute'),
  'criterion 123: log_event is not executable by anon, authenticated or public');
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
     where oid = 'private.log_claim_event()'::regprocedure)
  and (select proconfig = array['search_path=""'] from pg_proc
     where oid = 'private.bill_events_append_only()'::regprocedure),
  'claim event trigger is definer with empty search_path; the guard has an empty search_path');
select ok(
  (select bool_and(position('email' in lower(prosrc)) = 0) from pg_proc
     where oid in ('private.log_event(uuid,uuid,text,text,jsonb)'::regprocedure,
                   'private.log_claim_event()'::regprocedure,
                   'public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.join_bill(text)'::regprocedure,
                   'public.rotate_join_code(uuid)'::regprocedure,
                   'public.update_bill(uuid,jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.set_item_split(uuid,jsonb)'::regprocedure)),
  'no event writer references email');
select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute')
                   and not has_function_privilege('anon', p.oid, 'execute')
                   and prosecdef and proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in ('public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.join_bill(text)'::regprocedure,
                   'public.rotate_join_code(uuid)'::regprocedure,
                   'public.update_bill(uuid,jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.set_item_split(uuid,jsonb)'::regprocedure)),
  'the re-created writers keep definer, empty search_path and authenticated-only execute');
select ok(
  not exists (select 1 from pg_trigger where tgrelid = 'public.bill_events'::regclass and not tgisinternal
                and tgfoid = 'private.broadcast_bill_change()'::regprocedure),
  'no extra broadcast trigger on bill_events (writers already broadcast)');

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
    {"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":2,"total_cents":700},
    {"name":"Beer","note":null,"group_position":2,"unit_index":1,"group_size":2,"total_cents":700},
    {"name":"Soda","note":null,"group_position":3,"unit_index":0,"group_size":1,"total_cents":300}
  ]$json$::jsonb, null, 280, 0, 700, 0, 0, 4780);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
end $$;

set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.y_id', r.bill_id::text, true);
  perform set_config('test.y_code', r.join_code, true);
end $$;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_bill(current_setting('test.y_code'));
reset role;

do $$ begin
  perform set_config('test.burger', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Burger'), true);
  perform set_config('test.f', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Fries'), true);
  perform set_config('test.beer0', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 0), true);
  perform set_config('test.beer1', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 1), true);
  perform set_config('test.soda', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Soda'), true);
end $$;

-- ---------------------------------------------------------------------------
-- Criterion 124: bill_created and joined
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select actor_id::text, item_name, details from x_events where kind = 'bill_created' $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, null::text, '{"items": 4, "total_cents": 4780}'::jsonb) $$,
  'criterion 124: create_bill logs one bill_created (actor H, items = 4 form items, total_cents)');
select is((select count(*)::int from x_events), 1, 'criterion 124: create_bill logs exactly one event');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
reset role;

select results_eq(
  $$ select actor_id::text, item_name, details from x_events where kind = 'joined' order by 1 $$,
  $$ values ('a2000000-0000-0000-0000-000000000002'::text, null::text, '{}'::jsonb),
            ('a5000000-0000-0000-0000-000000000005'::text, null::text, '{}'::jsonb) $$,
  'criterion 124: one joined per new participant; P''s repeat join logs none');
select is(
  (select count(*)::int from public.bill_events where bill_id = current_setting('test.y_id')::uuid and kind = 'joined'),
  1, 'Q joining Y logs one joined event on Y');

-- ---------------------------------------------------------------------------
-- Criterion 125: claimed / unclaimed, unit and split
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, true);
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, true);
select public.set_claim(current_setting('test.f')::uuid, true);  -- no-op, logs nothing
select public.set_claim(current_setting('test.beer0')::uuid, true);
reset role;

select results_eq(
  $$ select actor_id::text, item_name, details from x_events where kind = 'claimed' order by 1, 2 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 'Fries'::text, '{"unit": null, "split": null}'::jsonb),
            ('a2000000-0000-0000-0000-000000000002'::text, 'Beer'::text, '{"unit": [0, 2], "split": null}'::jsonb),
            ('a2000000-0000-0000-0000-000000000002'::text, 'Fries'::text, '{"unit": null, "split": null}'::jsonb) $$,
  'criterion 125: claims log claimed with item_name; Beer 1 of 2 has unit [0, 2]; an even split logs split null; a repeat claim logs nothing');

-- Criterion 126: set_item_split logs split_changed; failed calls log nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_item_split(current_setting('test.f')::uuid,
  '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb);
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid, '{"a2000000-0000-0000-0000-000000000002": 2}'::jsonb) $$,
  '22023', 'claimers_changed', 'criterion 126 setup: omitting a claimer raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 0, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'criterion 126 setup: parts 0 raises 22023');
-- Same parts again: nothing changes, so nothing is logged.
select public.set_item_split(current_setting('test.f')::uuid,
  '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb);
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 1, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '42501', 'not_allowed', 'criterion 126 setup: R (not a claimer) raises 42501');
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 1, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  'P0002', 'not_found', 'criterion 126 setup: O (not a participant) raises P0002');
reset role;

select results_eq(
  $$ select actor_id::text, item_name, details from x_events where kind = 'split_changed' $$,
  $$ values ('a2000000-0000-0000-0000-000000000002'::text, 'Fries'::text,
       '{"unit": null,
         "before": {"a1000000-0000-0000-0000-000000000001": 1, "a2000000-0000-0000-0000-000000000002": 1},
         "after":  {"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}}'::jsonb) $$,
  'criterion 126: exactly one split_changed (actor P, before/after parts); failed and no-change calls log nothing');

-- R claims F (custom split kept, A2.3), then P and R unclaim.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, true);
reset role;
select results_eq(
  $$ select details from x_events where kind = 'claimed' and actor_id = 'a5000000-0000-0000-0000-000000000005' $$,
  $$ values ('{"unit": null, "split": {"a1000000-0000-0000-0000-000000000001": 2,
                                       "a2000000-0000-0000-0000-000000000002": 1,
                                       "a5000000-0000-0000-0000-000000000005": 1}}'::jsonb) $$,
  'criterion 125: R''s claim on a custom-split F logs split {H: 2, P: 1, R: 1}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, false);
select public.set_claim(current_setting('test.f')::uuid, false);  -- no-op, logs nothing
reset role;
select results_eq(
  $$ select item_name, details from x_events where kind = 'unclaimed' and actor_id = 'a2000000-0000-0000-0000-000000000002' $$,
  $$ values ('Fries'::text, '{"unit": null, "split": {"a1000000-0000-0000-0000-000000000001": 2,
                                                      "a5000000-0000-0000-0000-000000000005": 1}}'::jsonb) $$,
  'criterion 125: P''s unclaim logs unclaimed with split {H: 2, R: 1}; a repeat unclaim logs nothing');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, false);
reset role;
select results_eq(
  $$ select item_name, details from x_events where kind = 'unclaimed' and actor_id = 'a5000000-0000-0000-0000-000000000005' $$,
  $$ values ('Fries'::text, '{"unit": null, "split": null}'::jsonb) $$,
  'criterion 125: R''s unclaim (one claimer left) logs split null');

-- A direct claim insert (not through set_claim) is logged too; Soda gets P and R for criterion 127.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
insert into public.claims (bill_id, line_item_id, user_id)
  values (current_setting('test.x_id')::uuid, current_setting('test.soda')::uuid, 'a2000000-0000-0000-0000-000000000002');
select public.set_claim(current_setting('test.burger')::uuid, true);
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim(current_setting('test.soda')::uuid, true);
reset role;
select is(
  (select count(*)::int from x_events where kind = 'claimed' and item_name = 'Soda'),
  2, 'a direct insert into claims logs claimed, the same as set_claim');

-- ---------------------------------------------------------------------------
-- Criteria 120 and 122: who can read and write
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ insert into public.bill_events (bill_id, actor_id, kind) values
       (current_setting('test.x_id')::uuid, 'a2000000-0000-0000-0000-000000000002', 'joined') $$,
  '42501', null, 'criterion 120: P cannot insert into bill_events');
select throws_ok(
  $$ update public.bill_events set item_name = 'x' where bill_id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'criterion 120: P cannot update X''s events');
select throws_ok(
  $$ delete from public.bill_events where bill_id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'criterion 120: P cannot delete X''s events');
select throws_ok(
  $$ select private.log_event(current_setting('test.x_id')::uuid, null, 'joined', null, '{}'::jsonb) $$,
  '42501', null, 'criterion 123: P cannot call private.log_event');
select ok(
  (select count(*) from public.bill_events where bill_id = current_setting('test.x_id')::uuid) > 0,
  'criterion 122: P reads X''s events');
select is(
  (select count(*)::int from public.bill_events where bill_id = current_setting('test.y_id')::uuid),
  0, 'criterion 122: P reads none of Y''s events');
select is(
  (select count(*)::int from public.bill_events where bill_id <> current_setting('test.x_id')::uuid),
  0, 'criterion 122: an unfiltered select as P returns only X''s events');

set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select ok(
  (select count(*) from public.bill_events where bill_id = current_setting('test.x_id')::uuid) > 0,
  'criterion 122: R reads X''s events');

set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  (select count(*)::int from public.bill_events where bill_id = current_setting('test.x_id')::uuid),
  0, 'criterion 122: O (outsider) reads 0 of X''s events');
select ok(
  (select count(*) from public.bill_events where bill_id = current_setting('test.y_id')::uuid) > 0,
  'O reads Y''s events');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (current_setting('test.y_id')::uuid, 'joined') $$,
  '42501', null, 'criterion 120: O cannot insert even into O''s own bill');
reset role;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select count(*) from public.bill_events $$, '42501', null,
  'criterion 119: anon cannot read bill_events');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (current_setting('test.x_id')::uuid, 'joined') $$,
  '42501', null, 'criterion 119: anon cannot insert into bill_events');
select throws_ok(
  $$ select private.log_event(current_setting('test.x_id')::uuid, null, 'joined', null, '{}'::jsonb) $$,
  '42501', null, 'criterion 123: anon cannot call private.log_event');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 129: rotate_join_code
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$ select public.rotate_join_code(current_setting('test.x_id')::uuid) $$,
  '42501', 'not_allowed', 'criterion 129 setup: P cannot rotate');
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select set_config('test.new_code', public.rotate_join_code(current_setting('test.x_id')::uuid), true);
reset role;
select results_eq(
  $$ select actor_id::text, item_name, details from x_events where kind = 'link_rotated' $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, null::text, '{}'::jsonb) $$,
  'criterion 129: one link_rotated (actor H, details {}); P''s failed rotate logs nothing');
select ok(
  not exists (select 1 from x_events
              where details::text ~ current_setting('test.x_code')
                 or details::text ~ current_setting('test.new_code')
                 or details::text ~ '[0-9a-f]{20}'),
  'criterion 129: no event details contain the old or new join code');

-- ---------------------------------------------------------------------------
-- Criteria 127 and 128: update_bill
-- ---------------------------------------------------------------------------
create temp table seen as select id from public.bill_events;

-- Criterion 128: failures log nothing.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  format($$ select public.update_bill(%L::uuid, '[{"name":"X","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":100}]'::jsonb,
            null, 0, 0, 0, 0, 0, 100) $$, current_setting('test.x_id')),
  '42501', 'not_allowed', 'criterion 128 setup: P cannot update_bill');
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  format($$ select public.update_bill(%L::uuid, '[{"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":100}]'::jsonb,
            null, 0, 0, 0, 0, 0, 102) $$, current_setting('test.x_id')),
  '22023', 'invalid_bill', 'criterion 128 setup: a total 2 cents off raises 22023');
reset role;
select is((select count(*)::int from public.bill_events where id not in (select id from seen)), 0,
  'criterion 128: failed update_bill calls log nothing');

-- Criterion 128: identical content logs nothing.
do $$ begin
  perform set_config('test.rows_now', (
    select jsonb_agg(jsonb_build_object('id', li.id, 'name', li.name, 'note', li.note,
             'group_position', li.group_position, 'unit_index', li.unit_index,
             'group_size', li.group_size, 'total_cents', li.total_cents)
           order by li.group_position, li.unit_index)::text
    from public.line_items li where li.bill_id = current_setting('test.x_id')::uuid), true);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.rows_now')::jsonb,
  null, 280, 0, 700, 0, 0, 4780);
reset role;
select is((select count(*)::int from public.bill_events where id not in (select id from seen)), 0,
  'criterion 128: update_bill with identical content logs no events');

-- Criterion 127: Burger 1500 -> 1800, Beer qty 2 -> 1 (unit 1 dropped), Soda removed (claimed by
-- P and R), Wings added, tax 280 -> 300 (total 4780 -> 5000).
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, format($json$[
    {"id":%s,"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1800},
    {"id":%s,"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
    {"id":%s,"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":1,"total_cents":700},
    {"name":"Wings","note":null,"group_position":3,"unit_index":0,"group_size":1,"total_cents":900}
  ]$json$, to_json(current_setting('test.burger')), to_json(current_setting('test.f')),
           to_json(current_setting('test.beer0')))::jsonb,
  null, 300, 0, 700, 0, 0, 5000);
reset role;

select results_eq(
  $$ select kind, item_name, actor_id::text, details - 'claimer_ids'
     from public.bill_events where id not in (select id from seen) order by kind, item_name nulls first $$,
  $$ values
       ('amounts_changed'::text, null::text, 'a1000000-0000-0000-0000-000000000001'::text,
        '{"tax_cents": [280, 300], "total_cents": [4780, 5000]}'::jsonb),
       ('item_added', 'Wings', 'a1000000-0000-0000-0000-000000000001', '{"qty": 1, "price_cents": 900}'::jsonb),
       ('item_changed', 'Beer', 'a1000000-0000-0000-0000-000000000001', '{"qty": [2, 1], "price_cents": [1400, 700]}'::jsonb),
       ('item_changed', 'Burger', 'a1000000-0000-0000-0000-000000000001', '{"price_cents": [1500, 1800]}'::jsonb),
       ('item_removed', 'Soda', 'a1000000-0000-0000-0000-000000000001', '{"qty": 1, "price_cents": 300}'::jsonb) $$,
  'criterion 127: exactly item_changed Burger/Beer, item_removed Soda, item_added Wings, amounts_changed (changed fields only), and no unclaimed');
select results_eq(
  $$ select array(select jsonb_array_elements_text(details -> 'claimer_ids') order by 1)
     from public.bill_events where id not in (select id from seen) and kind = 'item_removed' $$,
  $$ values (array['a2000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000005']) $$,
  'criterion 127: item_removed Soda lists claimer_ids [P, R]');
select is(
  (select count(*)::int from public.claims where line_item_id = current_setting('test.soda')::uuid),
  0, 'criterion 127: Soda''s claims cascaded away (without unclaimed events, checked above)');

-- A3: discounts. Adding a 100 total discount logs only the A3 field that changed. There is no
-- combined discount_cents key (review R1): the app reads the two A3 keys, so a combined key made
-- the Activity screen show the same change twice.
delete from seen;
insert into seen select id from public.bill_events;
do $$ begin
  perform set_config('test.rows_now', (
    select jsonb_agg(jsonb_build_object('id', li.id, 'name', li.name, 'note', li.note,
             'group_position', li.group_position, 'unit_index', li.unit_index,
             'group_size', li.group_size, 'total_cents', li.total_cents)
           order by li.group_position, li.unit_index)::text
    from public.line_items li where li.bill_id = current_setting('test.x_id')::uuid), true);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.rows_now')::jsonb,
  null, 300, 0, 700, 0, 100, 4900);
reset role;
select results_eq(
  $$ select kind, details from public.bill_events where id not in (select id from seen) $$,
  $$ values ('amounts_changed'::text,
             '{"total_discount_cents": [0, 100], "total_cents": [5000, 4900]}'::jsonb) $$,
  'A3/R1: amounts_changed carries total_discount_cents and total_cents only');

-- Moving the same 100 from the total discount to the subtotal discount: both A3 fields change.
delete from seen;
insert into seen select id from public.bill_events;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.rows_now')::jsonb,
  null, 300, 0, 700, 100, 0, 4900);
reset role;
select results_eq(
  $$ select kind, details from public.bill_events where id not in (select id from seen) $$,
  $$ values ('amounts_changed'::text,
             '{"subtotal_discount_cents": [0, 100], "total_discount_cents": [100, 0]}'::jsonb) $$,
  'A3: moving a discount between positions logs both fields and no discount_cents');
select ok(
  not exists (select 1 from public.bill_events where kind = 'amounts_changed' and details ? 'discount_cents'),
  'R1: no amounts_changed event carries a combined discount_cents key');

-- Rename + note on a kept group: item_name is the new name.
delete from seen;
insert into seen select id from public.bill_events;
do $$ begin
  perform set_config('test.rows_renamed', (
    select jsonb_agg(case when r ->> 'name' = 'Fries'
                          then r || '{"name": "  Chips ", "note": "no salt"}'::jsonb else r end)::text
    from jsonb_array_elements(current_setting('test.rows_now')::jsonb) as r), true);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.rows_renamed')::jsonb,
  null, 300, 0, 700, 100, 0, 4900);
reset role;
select results_eq(
  $$ select kind, item_name, details from public.bill_events where id not in (select id from seen) $$,
  $$ values ('item_changed'::text, 'Chips'::text, '{"name": ["Fries", "Chips"], "note_changed": true}'::jsonb) $$,
  'item_changed for a rename + note: trimmed names, note_changed true, item_name is the new name');

-- Qty up on Beer (1 -> 3, kept unit 0 plus 2 new units) is ONE item_changed, not three item_added.
delete from seen;
insert into seen select id from public.bill_events;
do $$ begin
  perform set_config('test.rows_beer3', (
    select jsonb_agg(r order by (r ->> 'group_position')::int, (r ->> 'unit_index')::int)::text
    from (
      select case when r ->> 'name' = 'Beer'
                  then r || '{"group_size": 3, "total_cents": 700}'::jsonb else r end as r
      from jsonb_array_elements(current_setting('test.rows_renamed')::jsonb) as r
      union all
      select jsonb_build_object('name', 'Beer', 'note', null, 'group_position', 2, 'unit_index', i,
                                'group_size', 3, 'total_cents', 700)
      from generate_series(1, 2) as i
    ) as s), true);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.rows_beer3')::jsonb,
  null, 300, 0, 700, 100, 0, 6300);
reset role;
select results_eq(
  $$ select kind, item_name, details from public.bill_events where id not in (select id from seen) order by kind $$,
  $$ values ('amounts_changed'::text, null::text,
             '{"total_cents": [4900, 6300]}'::jsonb),
            ('item_changed', 'Beer', '{"qty": [1, 3], "price_cents": [700, 2100]}'::jsonb) $$,
  'Beer qty 1 -> 3 logs one item_changed for the group (per item, not per unit)');

-- Swapping two groups' positions alone logs nothing.
delete from seen;
insert into seen select id from public.bill_events;
do $$ begin
  perform set_config('test.rows_swapped', (
    select jsonb_agg(case r ->> 'group_position' when '0' then r || '{"group_position": 1}'::jsonb
                                                 when '1' then r || '{"group_position": 0}'::jsonb
                                                 else r end)::text
    from jsonb_array_elements(current_setting('test.rows_beer3')::jsonb) as r), true);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.rows_swapped')::jsonb,
  null, 300, 0, 700, 100, 0, 6300);
reset role;
select is((select count(*)::int from public.bill_events where id not in (select id from seen)), 0,
  'reordering groups alone logs nothing');

-- ---------------------------------------------------------------------------
-- Criterion 130: no emails anywhere in the events
-- ---------------------------------------------------------------------------
select ok(
  not exists (select 1 from public.bill_events
              where details::text ~ '@' or coalesce(item_name, '') ~ '@'),
  'criterion 130: no event details or item_name contain "@"');
select ok(
  not exists (select 1 from public.bill_events where details::text ~ '[0-9a-f]{20}'),
  'no event anywhere carries a join-code-shaped string');

-- ---------------------------------------------------------------------------
-- Criterion 131: defaults and the kind / details checks
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select private.log_event(current_setting('test.y_id')::uuid, null, 'confetti', null, '{}'::jsonb) $$,
  '23514', null, 'criterion 131: an unknown kind through log_event fails with 23514');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (current_setting('test.y_id')::uuid, 'confetti') $$,
  '23514', null, 'criterion 131: an unknown kind inserted as postgres fails with 23514');
select throws_ok(
  $$ select private.log_event(current_setting('test.y_id')::uuid, null, 'joined', null, '[]'::jsonb) $$,
  '23514', null, 'details must be a JSON object (23514)');
select throws_ok(
  $$ select private.log_event(current_setting('test.y_id')::uuid, null, 'claimed', repeat('a', 101), '{}'::jsonb) $$,
  '23514', null, 'item_name over 100 chars fails with 23514');
insert into public.bill_events (bill_id, kind) values (current_setting('test.y_id')::uuid, 'joined');
select results_eq(
  $$ select details, created_at is not null, actor_id is null, id is not null from public.bill_events
     where bill_id = current_setting('test.y_id')::uuid and kind = 'joined' and actor_id is null $$,
  $$ values ('{}'::jsonb, true, true, true) $$,
  'criterion 131: defaults: details {}, created_at now(), id generated');

-- ---------------------------------------------------------------------------
-- Criterion 121: the append-only guard (as postgres) and the cascades it lets through
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.bill_events set item_name = 'Rewritten' where bill_id = current_setting('test.x_id')::uuid $$,
  '42501', 'bill_events_append_only', 'criterion 121: as postgres, updating an X event raises 42501');
select throws_ok(
  $$ update public.bill_events set actor_id = null where bill_id = current_setting('test.x_id')::uuid and actor_id is not null $$,
  '42501', 'bill_events_append_only', 'criterion 121: nulling actor_id while the profile exists raises 42501');
select throws_ok(
  $$ delete from public.bill_events where bill_id = current_setting('test.x_id')::uuid $$,
  '42501', 'bill_events_append_only', 'criterion 121: as postgres, deleting an X event raises 42501');
select throws_ok(
  $$ truncate public.bill_events $$,
  '42501', 'bill_events_append_only', 'as postgres, truncating bill_events raises 42501');

-- Deleting R's account (a participant, not the host): R's events stay with actor_id null, and the
-- cascaded claim delete logs no unclaimed. R has a claim on Wings first.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim((select id from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Wings'), true);
reset role;
select set_config('test.r_events', (select count(*)::text from public.bill_events where actor_id = 'a5000000-0000-0000-0000-000000000005'), true);
select set_config('test.x_count', (select count(*)::text from x_events), true);
select lives_ok(
  $$ delete from auth.users where id = 'a5000000-0000-0000-0000-000000000005' $$,
  'criterion 121: deleting a participant''s account passes the guard (actor_id set null)');
select is(
  (select count(*)::int from x_events where actor_id is null),
  current_setting('test.r_events')::int,
  'criterion 121: the deleted participant''s events stay, with actor_id null ("Someone")');
select is((select count(*)::int from x_events), current_setting('test.x_count')::int,
  'deleting a participant''s account adds no events (no unclaimed for cascaded claims)');

-- Deleting H's account (as postgres; the test role may not SET ROLE supabase_auth_admin) cascades
-- to bill X and its events. Y's events are untouched.
select set_config('test.y_count', (select count(*)::text from public.bill_events where bill_id = current_setting('test.y_id')::uuid), true);
select lives_ok(
  $$ delete from auth.users where id = 'a1000000-0000-0000-0000-000000000001' $$,
  'criterion 121: deleting the host''s account passes the guard');
select is((select count(*)::int from public.bill_events where bill_id = current_setting('test.x_id')::uuid), 0,
  'criterion 121: deleting bill X (by deleting H) cascades and removes X''s events');
select is(
  (select count(*)::int from public.bill_events where bill_id = current_setting('test.y_id')::uuid),
  current_setting('test.y_count')::int,
  'Y''s events are untouched by X''s deletion');

select * from finish();
rollback;
