-- pgTAP tests for bills.extras_split and public.set_extras_split (spec
-- 2026-11-20-m1b-m2-share-and-claim.md, Task 18, criteria 143-147; A1.7, A2.1).
-- The event details shape is the one lib/activityText.ts reads: { before, after }.
--
-- Users: H a1... (host of X), P a2... and R a5... (participants of X),
--        O a3... (host of Y, outsider to X).
-- Broadcasts are checked by reading realtime.messages directly (as postgres).

begin;

create extension if not exists pgtap with schema extensions;

select plan(38);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('a5000000-0000-0000-0000-000000000005', 'r@test.local', '{"full_name":"Rae"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Schema, grants, function attributes (criteria 143, 147)
-- ---------------------------------------------------------------------------
select has_column('public', 'bills', 'extras_split', 'bills has an extras_split column');
select col_not_null('public', 'bills', 'extras_split', 'extras_split is not null');
select col_default_is('public', 'bills', 'extras_split', 'proportional'::text,
  'criterion 143: extras_split defaults to proportional');
select table_privs_are('public', 'bills', 'authenticated', array['SELECT'],
  'authenticated still has SELECT only on bills');
select table_privs_are('public', 'bills', 'anon', array[]::text[], 'anon has no privileges on bills');
select ok(has_column_privilege('authenticated', 'public.bills', 'extras_split', 'select')
          and not has_column_privilege('authenticated', 'public.bills', 'extras_split', 'update'),
  'authenticated can SELECT extras_split but not UPDATE it');
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
     where oid = 'public.set_extras_split(uuid,text)'::regprocedure),
  'criterion 147: set_extras_split is security definer with an empty search_path');
select ok(
  not has_function_privilege('anon', 'public.set_extras_split(uuid,text)', 'execute')
  and not has_function_privilege('public', 'public.set_extras_split(uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.set_extras_split(uuid,text)', 'execute'),
  'criterion 147: only authenticated may execute set_extras_split (not anon, not public)');
select function_returns('public', 'set_extras_split', array['uuid', 'text'], 'void',
  'set_extras_split(uuid, text) returns void');

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500}]'::jsonb,
    null, 100, 0, 200, 0, 0, 1800);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
  perform set_config('test.x_topic', 'bill:' || r.bill_id::text, true);
end $$;

set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.y_id', r.bill_id::text, true);
end $$;

set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
reset role;

create temp view x_split_events as
  select e.* from public.bill_events e
  where e.bill_id = current_setting('test.x_id', true)::uuid and e.kind = 'extras_split_changed';

select is((select extras_split from public.bills where id = current_setting('test.x_id')::uuid),
  'proportional', 'criterion 143: a new bill starts as proportional');

-- Criterion 143: the check constraint (as postgres) and no direct client update.
select throws_ok(
  $$ update public.bills set extras_split = 'even' where id = current_setting('test.x_id')::uuid $$,
  '23514', null, 'criterion 143: as postgres, extras_split = ''even'' violates the check (23514)');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ update public.bills set extras_split = 'equal' where id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'criterion 143: as P, a direct update of extras_split fails with 42501');
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ update public.bills set extras_split = 'equal' where id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'as H, a direct update of extras_split also fails with 42501 (function only)');

-- fetchBill reads it through RLS: a participant sees it, an outsider sees no row.
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select extras_split from public.bills where id = current_setting('test.x_id')::uuid),
  'proportional', 'participant P can read extras_split under RLS');
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*)::integer from public.bills where id = current_setting('test.x_id')::uuid),
  0, 'outsider O cannot see bill X (or its extras_split)');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 145: who can't
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  '42501', 'not_allowed', 'criterion 145: participant P gets 42501 not_allowed');
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  '42501', 'not_allowed', 'criterion 145: participant R gets 42501 not_allowed');
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$ select public.set_extras_split(gen_random_uuid(), 'equal') $$,
  '42501', 'not_allowed', 'criterion 145: H with a random bill id gets 42501 not_allowed');
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  '42501', 'not_allowed', 'criterion 145: outsider O with X''s id gets 42501 not_allowed');
select throws_ok($$ select public.set_extras_split(gen_random_uuid(), 'equal') $$,
  '42501', 'not_allowed', 'criterion 145: outsider O with a random id gets the same 42501 not_allowed');
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'bogus') $$,
  '42501', 'not_allowed', 'a non-host with an invalid mode still gets 42501 (no probing past the host check)');
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  '42501', 'not_allowed', 'no user (auth.uid() null) gets 42501 not_allowed');
reset role;

set local role anon;
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  '42501', null, 'criterion 147: anon cannot execute set_extras_split (42501)');
reset role;

select ok(
  (select extras_split = 'proportional' from public.bills where id = current_setting('test.x_id')::uuid)
  and (select count(*) = 0 from x_split_events)
  and (select count(*) = 0 from realtime.messages where topic like 'bill:%'),
  'criterion 145: after the denied calls nothing changed, nothing was logged, nothing was broadcast');

-- ---------------------------------------------------------------------------
-- Criterion 146: invalid modes
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'Equal') $$,
  '22023', 'invalid_mode', 'criterion 146: ''Equal'' raises 22023 invalid_mode');
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, '') $$,
  '22023', 'invalid_mode', 'criterion 146: '''' raises 22023 invalid_mode');
select throws_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, null) $$,
  '22023', 'invalid_mode', 'criterion 146: null raises 22023 invalid_mode');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 144: the host changes it
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  'criterion 144: H sets X to equal');
reset role;

select results_eq(
  $$ select extras_split, edited_at is null from public.bills where id = current_setting('test.x_id')::uuid $$,
  $$ values ('equal'::text, true) $$,
  'criterion 144: extras_split is equal and edited_at is unchanged (still null)');
select results_eq(
  $$ select actor_id, item_name, details from x_split_events $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid, null::text,
             '{"before":"proportional","after":"equal"}'::jsonb) $$,
  'criterion 144: exactly one extras_split_changed event, actor H, details {before: proportional, after: equal}');
select results_eq(
  $$ select topic, event, private, payload - 'id' from realtime.messages where topic like 'bill:%' $$,
  $$ values (current_setting('test.x_topic'), 'changed'::text, true, '{"t":"bills"}'::jsonb) $$,
  'criterion 144: exactly one private ''changed'' broadcast {"t":"bills"} on bill:<X>');
select is(
  (select count(*)::integer from public.bill_events where bill_id = current_setting('test.y_id')::uuid
     and kind = 'extras_split_changed'),
  0, 'no event is written on another bill');

-- Criterion 146: setting the same value again is a no-op.
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'equal') $$,
  'criterion 146: setting equal again succeeds');
reset role;
select is((select count(*)::integer from x_split_events), 1,
  'criterion 146: setting equal twice logs only one event');
select is((select count(*)::integer from realtime.messages where topic like 'bill:%'), 0,
  'setting the current value again sends no broadcast (no update happened)');

-- Switching back logs the reverse.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.set_extras_split(current_setting('test.x_id')::uuid, 'proportional') $$,
  'H switches X back to proportional');
-- Participants read the event under RLS (the Activity screen's query).
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select results_eq(
  $$ select details from public.bill_events
       where bill_id = current_setting('test.x_id')::uuid and kind = 'extras_split_changed'
       order by created_at, (details ->> 'before') desc $$,
  $$ values ('{"before":"proportional","after":"equal"}'::jsonb), ('{"before":"equal","after":"proportional"}'::jsonb) $$,
  'P reads both events: proportional -> equal, then equal -> proportional');
reset role;

select is((select extras_split from public.bills where id = current_setting('test.x_id')::uuid),
  'proportional', 'X is proportional again');

select * from finish();
rollback;
