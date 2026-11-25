-- pgTAP tests for the M2 database review fixes (spec 2026-11-20-m1b-m2-share-and-claim.md, A1-A3;
-- review findings R2-R8). R1 (amounts_changed keys) is covered in bill_events.test.sql.
--
-- Users: H b1... 'Hana' (host of X), P b2... 'Pat', R b5... 'Rae' (participants of X),
--        O b3... 'Oli' (outsider, host of Y).
-- Bill X: Burger 1500, Fries 600, Beer x3 (700 each); tax 0, tip 0, total 4200.

begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

insert into auth.users (id, email, raw_user_meta_data) values
  ('b1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('b2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('b3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('b5000000-0000-0000-0000-000000000005', 'r@test.local', '{"full_name":"Rae"}'::jsonb);

-- ---------------------------------------------------------------------------
-- R2: the append-only guard is security definer, owned by postgres, empty search_path
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef from pg_proc where oid = 'private.bill_events_append_only()'::regprocedure),
  'R2: bill_events_append_only is security definer');
select is(
  (select proowner::regrole::text from pg_proc where oid = 'private.bill_events_append_only()'::regprocedure),
  'postgres', 'R2: bill_events_append_only is owned by postgres');
select is(
  (select proconfig from pg_proc where oid = 'private.bill_events_append_only()'::regprocedure),
  array['search_path=""'], 'R2: bill_events_append_only has an empty search_path');
select ok(
  not has_function_privilege('public', 'private.bill_events_append_only()', 'execute')
  and not has_function_privilege('anon', 'private.bill_events_append_only()', 'execute')
  and not has_function_privilege('authenticated', 'private.bill_events_append_only()', 'execute'),
  'R2: bill_events_append_only is not executable by public, anon or authenticated');

-- ---------------------------------------------------------------------------
-- R3: service_role cannot write bill_events
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('service_role', 'public.bill_events', 'INSERT')
  and not has_table_privilege('service_role', 'public.bill_events', 'UPDATE')
  and not has_table_privilege('service_role', 'public.bill_events', 'DELETE')
  and not has_table_privilege('service_role', 'public.bill_events', 'TRUNCATE')
  and has_table_privilege('service_role', 'public.bill_events', 'SELECT'),
  'R3: service_role has no INSERT, UPDATE, DELETE or TRUNCATE on bill_events (SELECT kept)');

-- ---------------------------------------------------------------------------
-- R7 / R8: profiles grants and policy
-- ---------------------------------------------------------------------------
select table_privs_are('public', 'profiles', 'authenticated', array[]::text[],
  'R7: authenticated has no table-level privileges on profiles');
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'id', 'SELECT')
  and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'SELECT')
  and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'SELECT')
  and not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'SELECT'),
  'R7: authenticated can select id and display_name, not created_at or updated_at');
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE'),
  'R7: authenticated can still update display_name only');
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'),
  1, 'R8: profiles has exactly one SELECT policy');
select ok(
  (select count(*) = 1
          and bool_and(roles = '{authenticated}' and permissive = 'PERMISSIVE'
                       and qual ~ 'auth\.uid\(\)' and qual ~ 'private\.shares_bill_with\(id\)')
   from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'),
  'R8: the one SELECT policy is for authenticated and covers own row or shared bill');

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
    {"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":3,"total_cents":700},
    {"name":"Beer","note":null,"group_position":2,"unit_index":1,"group_size":3,"total_cents":700},
    {"name":"Beer","note":null,"group_position":2,"unit_index":2,"group_size":3,"total_cents":700}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 4200);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
end $$;
set local request.jwt.claims = '{"sub":"b3000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.y_id', r.bill_id::text, true);
end $$;
set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"b5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
reset role;

do $$ begin
  perform set_config('test.burger', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Burger'), true);
  perform set_config('test.fries', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Fries'), true);
  perform set_config('test.beer0', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 0), true);
  perform set_config('test.beer1', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 1), true);
  perform set_config('test.beer2', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 2), true);
end $$;

-- R claims Beer unit 1 (index 0); P claims Beer unit 2 (index 1) and Fries.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim(current_setting('test.beer0')::uuid, true);
set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.beer1')::uuid, true);
select public.set_claim(current_setting('test.fries')::uuid, true);
reset role;

create temp table seen as select id from public.bill_events;

-- ---------------------------------------------------------------------------
-- R7: what co-participants and the owner can read on profiles
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Hana'::text), ('Pat'), ('Rae') $$,
  'R7/R8: P reads own and co-participants'' display_name (not the outsider''s)');
select throws_ok(
  $$ select created_at from public.profiles where id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'R7: P cannot read a co-participant''s created_at');
select throws_ok(
  $$ select updated_at from public.profiles where id = 'b2000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'R7: P cannot read even their own updated_at (display_name only)');
select throws_ok(
  $$ select * from public.profiles $$,
  '42501', null, 'R7: select * on profiles is denied (column grants only)');
select isnt_empty(
  $$ update public.profiles set display_name = 'Patty'
     where id = 'b2000000-0000-0000-0000-000000000002' returning id, display_name $$,
  'R7: P can still update their own display_name (where on id, returning id/display_name)');
select results_eq(
  $$ select bp.user_id::text, pr.display_name
     from public.bill_participants bp
     join public.profiles pr on pr.id = bp.user_id
     where bp.bill_id = current_setting('test.x_id')::uuid order by 2 $$,
  $$ values ('b1000000-0000-0000-0000-000000000001'::text, 'Hana'::text),
            ('b2000000-0000-0000-0000-000000000002', 'Patty'),
            ('b5000000-0000-0000-0000-000000000005', 'Rae') $$,
  'R7: the participant + display_name join the app embeds still works');
set local request.jwt.claims = '{"sub":"b3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select results_eq(
  $$ select display_name from public.profiles $$,
  $$ values ('Oli'::text) $$,
  'R8: the outsider O reads only their own profile');
reset role;

-- ---------------------------------------------------------------------------
-- R4: one new group made of kept ids from two old groups is rejected
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  format($$ select public.update_bill(%L::uuid, %L::jsonb, null, 0, 0, 0, 0, 0, 4200) $$,
    current_setting('test.x_id'),
    format($json$[
      {"id":%s,"name":"Combo","note":null,"group_position":0,"unit_index":0,"group_size":2,"total_cents":1500},
      {"id":%s,"name":"Combo","note":null,"group_position":0,"unit_index":1,"group_size":2,"total_cents":600},
      {"id":%s,"name":"Beer","note":null,"group_position":1,"unit_index":0,"group_size":3,"total_cents":700},
      {"id":%s,"name":"Beer","note":null,"group_position":1,"unit_index":1,"group_size":3,"total_cents":700},
      {"id":%s,"name":"Beer","note":null,"group_position":1,"unit_index":2,"group_size":3,"total_cents":700}
    ]$json$, to_json(current_setting('test.burger')), to_json(current_setting('test.fries')),
             to_json(current_setting('test.beer0')), to_json(current_setting('test.beer1')),
             to_json(current_setting('test.beer2')))),
  '22023', 'invalid_bill', 'R4: merging kept rows of Burger and Fries into one group raises 22023 invalid_bill');
reset role;
select is((select count(*)::int from public.bill_events where id not in (select id from seen)), 0,
  'R4: the rejected merge logs nothing');
select results_eq(
  $$ select name, group_position from public.line_items
     where id in (current_setting('test.burger')::uuid, current_setting('test.fries')::uuid) order by 2 $$,
  $$ values ('Burger'::text, 0), ('Fries', 1) $$,
  'R4: the rejected merge changes no rows');
select is(
  (select count(*)::int from public.claims where line_item_id = current_setting('test.fries')::uuid),
  1, 'R4: the rejected merge keeps P''s Fries claim');

-- ---------------------------------------------------------------------------
-- R5: lowering a quantity that drops claimed units lists who lost a claim
-- ---------------------------------------------------------------------------
-- Beer x3 -> x2, dropping unit 3 (unclaimed): no removed_claimer_ids key.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, format($json$[
    {"id":%s,"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"id":%s,"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
    {"id":%s,"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":2,"total_cents":700},
    {"id":%s,"name":"Beer","note":null,"group_position":2,"unit_index":1,"group_size":2,"total_cents":700}
  ]$json$, to_json(current_setting('test.burger')), to_json(current_setting('test.fries')),
           to_json(current_setting('test.beer0')), to_json(current_setting('test.beer1')))::jsonb,
  null, 0, 0, 0, 0, 0, 3500);
reset role;
select results_eq(
  $$ select kind, item_name, details from public.bill_events
     where id not in (select id from seen) and kind like 'item_%' $$,
  $$ values ('item_changed'::text, 'Beer'::text, '{"qty": [3, 2], "price_cents": [2100, 1400]}'::jsonb) $$,
  'R5: dropping an unclaimed unit logs item_changed without removed_claimer_ids');

-- Beer x2 -> x1, dropping unit 2 (P's claim), keeping unit 1 (R's).
delete from seen;
insert into seen select id from public.bill_events;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_bill(current_setting('test.x_id')::uuid, format($json$[
    {"id":%s,"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"id":%s,"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
    {"id":%s,"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":1,"total_cents":700}
  ]$json$, to_json(current_setting('test.burger')), to_json(current_setting('test.fries')),
           to_json(current_setting('test.beer0')))::jsonb,
  null, 0, 0, 0, 0, 0, 2800);
reset role;
select results_eq(
  $$ select kind, item_name, actor_id::text, details from public.bill_events
     where id not in (select id from seen) and kind like 'item_%' $$,
  $$ values ('item_changed'::text, 'Beer'::text, 'b1000000-0000-0000-0000-000000000001'::text,
             '{"qty": [2, 1], "price_cents": [1400, 700],
               "removed_claimer_ids": ["b2000000-0000-0000-0000-000000000002"]}'::jsonb) $$,
  'R5: Beer x2 -> x1 dropping P''s unit logs item_changed with removed_claimer_ids [P]');
select is(
  (select count(*)::int from public.bill_events where id not in (select id from seen) and kind = 'unclaimed'),
  0, 'R5: the cascaded claim delete still logs no unclaimed');
select is(
  (select count(*)::int from public.claims where line_item_id = current_setting('test.beer0')::uuid),
  1, 'R5: R''s claim on the kept Beer unit stays');

-- ---------------------------------------------------------------------------
-- R6: set_claim on a row deleted underneath it raises P0002 not_found
-- ---------------------------------------------------------------------------
-- Simulates the concurrent edit: a BEFORE INSERT trigger on claims (as postgres) deletes the line
-- item after set_claim has read it, so the insert's foreign key check fails (23503).
create function pg_temp.delete_line_item_first() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.line_items as li where li.id = new.line_item_id;
  return new;
end $$;
create trigger zz_test_delete_line_item_first before insert on public.claims
  for each row execute function pg_temp.delete_line_item_first();

set local role authenticated;
set local request.jwt.claims = '{"sub":"b5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select public.set_claim(current_setting('test.burger')::uuid, true) $$,
  'P0002', 'not_found', 'R6: set_claim on a row deleted by a concurrent edit raises P0002 not_found');
reset role;
drop trigger zz_test_delete_line_item_first on public.claims;

-- The function body really catches the error (not some earlier check).
select ok(
  (select prosrc ~* 'foreign_key_violation' from pg_proc where oid = 'public.set_claim(uuid,boolean)'::regprocedure),
  'R6: set_claim handles foreign_key_violation');
select ok(
  (select not prosecdef and proconfig = array['search_path=""'] from pg_proc
     where oid = 'public.set_claim(uuid,boolean)'::regprocedure)
  and has_function_privilege('authenticated', 'public.set_claim(uuid,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.set_claim(uuid,boolean)', 'execute'),
  'R6: set_claim stays security invoker, empty search_path, authenticated-only');

set local role authenticated;
set local request.jwt.claims = '{"sub":"b5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select lives_ok(
  $$ select public.set_claim(current_setting('test.fries')::uuid, true) $$,
  'R6: an ordinary claim still works');
set local request.jwt.claims = '{"sub":"b3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.set_claim(current_setting('test.fries')::uuid, true) $$,
  'P0002', 'not_found', 'R6: an outsider still gets P0002 not_found');
reset role;

-- ---------------------------------------------------------------------------
-- R3: service_role writes are denied; the cascades still work
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (current_setting('test.x_id')::uuid, 'joined') $$,
  '42501', null, 'R3: service_role cannot insert into bill_events');
select throws_ok(
  $$ update public.bill_events set item_name = 'x' where bill_id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'R3: service_role cannot update bill_events');
select throws_ok(
  $$ delete from public.bill_events where bill_id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'R3: service_role cannot delete from bill_events');
select throws_ok(
  $$ truncate public.bill_events $$,
  '42501', null, 'R3: service_role cannot truncate bill_events');

-- Deleting P's profile as service_role: bill_events.actor_id is set null by the FK action.
select set_config('test.p_events',
  (select count(*)::text from public.bill_events where actor_id = 'b2000000-0000-0000-0000-000000000002'), true);
select lives_ok(
  $$ delete from public.profiles where id = 'b2000000-0000-0000-0000-000000000002' $$,
  'R3: service_role deleting a profile passes (actor_id set null by the FK action)');
reset role;
select ok(
  current_setting('test.p_events')::int > 0
  and not exists (select 1 from public.bill_events where actor_id = 'b2000000-0000-0000-0000-000000000002'),
  'R3: P''s events remain with actor_id null after the profile delete');

-- Deleting bill Y as service_role cascades its events.
set local role service_role;
select lives_ok(
  $$ delete from public.bills where id = current_setting('test.y_id')::uuid $$,
  'R3: service_role deleting a bill passes the guard (events cascade)');
reset role;
select is((select count(*)::int from public.bill_events where bill_id = current_setting('test.y_id')::uuid), 0,
  'R3: the deleted bill''s events are gone');

-- Account delete (auth.users, as postgres) of the host cascades bill X and its events.
select lives_ok(
  $$ delete from auth.users where id = 'b1000000-0000-0000-0000-000000000001' $$,
  'R3: deleting the host''s account still works');
select is((select count(*)::int from public.bill_events where bill_id = current_setting('test.x_id')::uuid), 0,
  'R3: the host''s account delete removed bill X''s events');

select * from finish();
rollback;
