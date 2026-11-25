-- pgTAP tests for M3 Task 1 (spec docs/specs/2026-11-24-m3-settle-venmo.md, criteria 1-13):
-- bills.payer_id, the mark columns, invariant P, account deletion, grants, set_payer, the
-- bill_participants update broadcast and the new Activity kinds.
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
--
-- Users: A e1... 'Hana' (host of X), B e2... 'Sam', D e4... 'Dee' (participants of X),
--        C e3... 'Cal' (outsider, host of Y), E e5... 'Eve' (host of Z), F e6... 'Fay' (in Z).
-- Bill X: Burger 1500, Salad 1000; total 2500. Bill Y: Tea 300. Bill Z: Soup 800.

begin;

create extension if not exists pgtap with schema extensions;

select plan(59);

insert into auth.users (id, email, raw_user_meta_data) values
  ('e1000000-0000-0000-0000-000000000001', 'settle-a@test.local', '{"full_name":"Hana"}'::jsonb),
  ('e2000000-0000-0000-0000-000000000002', 'settle-b@test.local', '{"full_name":"Sam"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000003', 'settle-c@test.local', '{"full_name":"Cal"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000004', 'settle-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('e5000000-0000-0000-0000-000000000005', 'settle-e@test.local', '{"full_name":"Eve"}'::jsonb),
  ('e6000000-0000-0000-0000-000000000006', 'settle-f@test.local', '{"full_name":"Fay"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Criterion 1: columns and constraints
-- ---------------------------------------------------------------------------
select col_type_is('public', 'bills', 'payer_id', 'uuid', 'c1: bills.payer_id is uuid');
select col_not_null('public', 'bills', 'payer_id', 'c1: bills.payer_id is not null');
select col_type_is('public', 'bill_participants', 'settled_at', 'timestamp with time zone',
  'c1: bill_participants.settled_at is timestamptz');
select col_is_null('public', 'bill_participants', 'settled_at', 'c1: settled_at is nullable');
select col_type_is('public', 'bill_participants', 'settled_cents', 'integer',
  'c1: bill_participants.settled_cents is integer');
select col_is_null('public', 'bill_participants', 'settled_cents', 'c1: settled_cents is nullable');

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1000}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 2500);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
  perform set_config('test.x_topic', 'bill:' || r.bill_id::text, true);
end $$;
set local request.jwt.claims = '{"sub":"e3000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.y_id', r.bill_id::text, true);
end $$;
set local request.jwt.claims = '{"sub":"e5000000-0000-0000-0000-000000000005","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Soup","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":800}]'::jsonb,
    null, 0, 0, 0, 0, 0, 800);
  perform set_config('test.z_id', r.bill_id::text, true);
  perform set_config('test.z_code', r.join_code, true);
end $$;
set local request.jwt.claims = '{"sub":"e2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"e4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"e6000000-0000-0000-0000-000000000006","role":"authenticated"}';
select public.join_bill(current_setting('test.z_code'));
reset role;

-- Criterion 1 (continued): the mark constraints, as superuser (23514 check_violation).
select throws_ok(
  $$ update public.bill_participants set settled_at = now()
     where bill_id = current_setting('test.x_id')::uuid and user_id = 'e2000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'c1: settled_at without settled_cents fails with 23514');
select throws_ok(
  $$ update public.bill_participants set settled_at = now(), settled_cents = 0
     where bill_id = current_setting('test.x_id')::uuid and user_id = 'e2000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'c1: settled_cents = 0 fails with 23514');
select throws_ok(
  $$ update public.bill_participants set settled_at = now(), settled_cents = 100000000
     where bill_id = current_setting('test.x_id')::uuid and user_id = 'e2000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'c1: settled_cents = 100000000 fails with 23514');
select throws_ok(
  $$ update public.bill_participants set settled_cents = 5
     where bill_id = current_setting('test.x_id')::uuid and user_id = 'e2000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'c1: settled_cents without settled_at fails with 23514');

-- ---------------------------------------------------------------------------
-- Criterion 2: create_bill makes the host the payer
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.bills
   where id in (current_setting('test.x_id')::uuid, current_setting('test.y_id')::uuid,
                current_setting('test.z_id')::uuid)
     and payer_id = host_id),
  3, 'c2: bills made through create_bill have payer_id = host_id');
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x_id')::uuid and settled_at is not null),
  0, 'c2: new participant rows have no mark');

-- ---------------------------------------------------------------------------
-- Criterion 5: grants
-- ---------------------------------------------------------------------------
select table_privs_are('public', 'bills', 'authenticated', array['SELECT'],
  'c5: authenticated has only SELECT on bills');
select table_privs_are('public', 'bill_participants', 'authenticated', array['SELECT'],
  'c5: authenticated has only SELECT on bill_participants');
select table_privs_are('public', 'bills', 'anon', array[]::text[], 'c5: anon has nothing on bills');
select table_privs_are('public', 'bill_participants', 'anon', array[]::text[],
  'c5: anon has nothing on bill_participants');
select ok(
  not has_column_privilege('authenticated', 'public.bills', 'payer_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.bill_participants', 'settled_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.bill_participants', 'settled_cents', 'UPDATE'),
  'c5: no column-level UPDATE on payer_id, settled_at or settled_cents');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (select payer_id from public.bills where id = current_setting('test.x_id')::uuid),
  'e1000000-0000-0000-0000-000000000001'::uuid, 'c5: B (participant) can read payer_id');
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x_id')::uuid and settled_at is null and settled_cents is null),
  3, 'c5: B can read every participant''s mark columns (Q5 A)');
select throws_ok(
  $$ update public.bills set payer_id = 'e2000000-0000-0000-0000-000000000002'
     where id = current_setting('test.x_id')::uuid $$,
  '42501', null, 'c5: B cannot update bills.payer_id (42501)');
select throws_ok(
  $$ update public.bill_participants set settled_at = now(), settled_cents = 1
     where bill_id = current_setting('test.x_id')::uuid and user_id = 'e2000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'c5: B cannot update their own mark directly (42501)');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 13: set_payer's security settings
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef from pg_proc where oid = 'public.set_payer(uuid,uuid,integer)'::regprocedure),
  'c13: set_payer is security definer');
select is(
  (select proconfig from pg_proc where oid = 'public.set_payer(uuid,uuid,integer)'::regprocedure),
  array['search_path=""'], 'c13: set_payer has an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.set_payer(uuid,uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.set_payer(uuid,uuid,integer)', 'execute')
  and not has_function_privilege('public', 'public.set_payer(uuid,uuid,integer)', 'execute'),
  'c13: set_payer is executable by authenticated only');

-- ---------------------------------------------------------------------------
-- Criterion 6: the host sets B as payer (no marks)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e2000000-0000-0000-0000-000000000002', 0) $$,
  'c6: A sets B as payer with expected 0');
reset role;
select is(
  (select payer_id from public.bills where id = current_setting('test.x_id')::uuid),
  'e2000000-0000-0000-0000-000000000002'::uuid, 'c6: payer_id is now B');
select results_eq(
  $$ select actor_id, details from public.bill_events
     where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed' $$,
  $$ values ('e1000000-0000-0000-0000-000000000001'::uuid,
             '{"before":"e1000000-0000-0000-0000-000000000001","after":"e2000000-0000-0000-0000-000000000002","cleared":0}'::jsonb) $$,
  'c6: exactly one payer_changed {before A, after B, cleared 0}, actor A');

-- ---------------------------------------------------------------------------
-- Criterion 7: only the host, and only for an existing bill
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', 0) $$,
  '42501', 'not_allowed', 'c7: B (non-host participant) gets 42501');
set local request.jwt.claims = '{"sub":"e3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', 0) $$,
  '42501', 'not_allowed', 'c7: C (outsider) gets 42501');
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.set_payer('00000000-0000-0000-0000-00000000dead', 'e4000000-0000-0000-0000-000000000004', 0) $$,
  '42501', 'not_allowed', 'c7: A with an unknown bill id gets 42501');
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', 0) $$,
  '42501', 'not_allowed', 'c7: authenticated with no user id gets 42501');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', 0) $$,
  '42501', null, 'c7: anon gets 42501');
reset role;
select ok(
  (select payer_id = 'e2000000-0000-0000-0000-000000000002'::uuid from public.bills
   where id = current_setting('test.x_id')::uuid)
  and (select count(*) = 1 from public.bill_events
       where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed'),
  'c7: after the denied calls the payer is still B and no event was added');

-- ---------------------------------------------------------------------------
-- Criterion 8: the new payer must be a participant
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e3000000-0000-0000-0000-000000000003', 0) $$,
  '22023', 'not_participant', 'c8: C (not a participant) gives 22023 not_participant');
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, null, 0) $$,
  '22023', 'not_participant', 'c8: a null payer gives 22023 not_participant');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 9: the current payer again is a no-op, even with a wrong expected count
-- ---------------------------------------------------------------------------
update public.bill_participants set settled_at = now(), settled_cents = 700
where bill_id = current_setting('test.x_id')::uuid and user_id = 'e4000000-0000-0000-0000-000000000004';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e2000000-0000-0000-0000-000000000002', 5) $$,
  'c9: set_payer(current payer B, 5) raises nothing');
reset role;
select ok(
  (select payer_id = 'e2000000-0000-0000-0000-000000000002'::uuid from public.bills
   where id = current_setting('test.x_id')::uuid)
  and (select settled_cents = 700 from public.bill_participants
       where bill_id = current_setting('test.x_id')::uuid and user_id = 'e4000000-0000-0000-0000-000000000004')
  and (select count(*) = 1 from public.bill_events
       where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed'),
  'c9: no-op: payer still B, D''s mark kept, no new event');

-- ---------------------------------------------------------------------------
-- Criterion 10: the expected mark count must match
-- ---------------------------------------------------------------------------
-- Payer back to A and both B and D marked (as superuser; no event).
update public.bills set payer_id = 'e1000000-0000-0000-0000-000000000001'
where id = current_setting('test.x_id')::uuid;
update public.bill_participants set settled_at = now(), settled_cents = 1510
where bill_id = current_setting('test.x_id')::uuid and user_id = 'e2000000-0000-0000-0000-000000000002';

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', 1) $$,
  '22023', 'marks_changed', 'c10: expected 1 with 2 marks gives 22023 marks_changed');
select throws_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', null) $$,
  '22023', 'marks_changed', 'c10: expected null gives 22023 marks_changed');
reset role;
select ok(
  (select payer_id = 'e1000000-0000-0000-0000-000000000001'::uuid from public.bills
   where id = current_setting('test.x_id')::uuid)
  and (select count(*) = 2 from public.bill_participants
       where bill_id = current_setting('test.x_id')::uuid and settled_at is not null)
  and (select count(*) = 1 from public.bill_events
       where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed'),
  'c10: after marks_changed the payer is still A, both marks kept, no event');

delete from realtime.messages where topic = current_setting('test.x_topic');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.set_payer(current_setting('test.x_id')::uuid, 'e4000000-0000-0000-0000-000000000004', 2) $$,
  'c10: expected 2 with 2 marks succeeds');
reset role;
select ok(
  (select payer_id = 'e4000000-0000-0000-0000-000000000004'::uuid from public.bills
   where id = current_setting('test.x_id')::uuid)
  and (select count(*) = 0 from public.bill_participants
       where bill_id = current_setting('test.x_id')::uuid
         and (settled_at is not null or settled_cents is not null)),
  'c10: payer is D and both marks are cleared');
select results_eq(
  $$ select actor_id, details from public.bill_events
     where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed'
       and details ->> 'after' = 'e4000000-0000-0000-0000-000000000004' $$,
  $$ values ('e1000000-0000-0000-0000-000000000001'::uuid,
             '{"before":"e1000000-0000-0000-0000-000000000001","after":"e4000000-0000-0000-0000-000000000004","cleared":2}'::jsonb) $$,
  'c10: one payer_changed {before A, after D, cleared 2}, actor A');
select is(
  (select count(*)::int from realtime.messages
   where topic = current_setting('test.x_topic') and payload ->> 't' = 'bill_participants'),
  1, 'c10/c11: set_payer''s clear of 2 marks sends one bill_participants broadcast');

-- ---------------------------------------------------------------------------
-- Criterion 11: one update statement over N rows sends one broadcast
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic = current_setting('test.x_topic');
update public.bill_participants set settled_at = now(), settled_cents = 100
where bill_id = current_setting('test.x_id')::uuid
  and user_id in ('e1000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002');
select results_eq(
  $$ select topic, event, private, payload - 'id' from realtime.messages
     where topic = current_setting('test.x_topic') $$,
  $$ values (current_setting('test.x_topic'), 'changed'::text, true, '{"t":"bill_participants"}'::jsonb) $$,
  'c11: an update of 2 participant rows sends exactly one private broadcast on bill:<X>');
update public.bill_participants set settled_at = null, settled_cents = null
where bill_id = current_setting('test.x_id')::uuid;

-- ---------------------------------------------------------------------------
-- Criterion 4: the payer's account is deleted
-- ---------------------------------------------------------------------------
-- Payer B, and B and D marked (set as superuser).
update public.bills set payer_id = 'e2000000-0000-0000-0000-000000000002'
where id = current_setting('test.x_id')::uuid;
update public.bill_participants set settled_at = now(), settled_cents = 900
where bill_id = current_setting('test.x_id')::uuid
  and user_id in ('e2000000-0000-0000-0000-000000000002', 'e4000000-0000-0000-0000-000000000004');

select lives_ok(
  $$ delete from auth.users where id = 'e2000000-0000-0000-0000-000000000002' $$,
  'c4: deleting the payer B''s account succeeds');
select ok(
  exists (select 1 from public.bills where id = current_setting('test.x_id')::uuid)
  and (select payer_id = host_id from public.bills where id = current_setting('test.x_id')::uuid),
  'c4: the bill still exists and its payer is the host again');
select ok(
  not exists (select 1 from public.bill_participants
              where bill_id = current_setting('test.x_id')::uuid
                and user_id = 'e2000000-0000-0000-0000-000000000002')
  and (select count(*) = 0 from public.bill_participants
       where bill_id = current_setting('test.x_id')::uuid
         and (settled_at is not null or settled_cents is not null)),
  'c4: B''s participant row is gone and every remaining mark is null');
select results_eq(
  $$ select details from public.bill_events
     where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed' and actor_id is null $$,
  $$ values ('{"before":"e2000000-0000-0000-0000-000000000002","after":"e1000000-0000-0000-0000-000000000001","cleared":2}'::jsonb) $$,
  'c4: exactly one payer_changed with actor null and cleared = 2 (both removed marks)');
select lives_ok(
  $$ set constraints public.bills_payer_participant_fkey immediate $$,
  'c4: invariant P holds after the deletion');
set constraints public.bills_payer_participant_fkey deferred;

-- A non-payer's deletion doesn't touch the payer and logs nothing.
select lives_ok(
  $$ delete from auth.users where id = 'e4000000-0000-0000-0000-000000000004' $$,
  'c4: deleting a non-payer participant (D) succeeds');
select ok(
  (select payer_id = 'e1000000-0000-0000-0000-000000000001'::uuid from public.bills
   where id = current_setting('test.x_id')::uuid)
  and (select count(*) = 1 from public.bill_events
       where bill_id = current_setting('test.x_id')::uuid and kind = 'payer_changed' and actor_id is null),
  'c4: D''s deletion changes no payer and logs no payer_changed');

-- The host is deleted while someone else is the payer: the whole bill cascades.
update public.bills set payer_id = 'e6000000-0000-0000-0000-000000000006'
where id = current_setting('test.z_id')::uuid;
select lives_ok(
  $$ delete from auth.users where id = 'e5000000-0000-0000-0000-000000000005' $$,
  'c4: deleting the host E of bill Z (payer F) succeeds');
select ok(
  not exists (select 1 from public.bills where id = current_setting('test.z_id')::uuid)
  and not exists (select 1 from public.bill_participants where bill_id = current_setting('test.z_id')::uuid),
  'c4: bill Z and its participant rows are gone');
select lives_ok(
  $$ set constraints public.bills_payer_participant_fkey immediate $$,
  'c4: invariant P holds after the host deletion');
set constraints public.bills_payer_participant_fkey deferred;

-- ---------------------------------------------------------------------------
-- Criterion 3: invariant P rejects a payer who isn't a participant
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ do $x$ begin
       update public.bills set payer_id = 'e3000000-0000-0000-0000-000000000003'
       where id = current_setting('test.x_id')::uuid;
       set constraints public.bills_payer_participant_fkey immediate;
     end $x$ $$,
  '23503', null,
  'c3: a non-participant payer fails with 23503 (deferred FK bills_payer_participant_fkey) at commit');
set constraints public.bills_payer_participant_fkey deferred;
select is(
  (select payer_id from public.bills where id = current_setting('test.x_id')::uuid),
  'e1000000-0000-0000-0000-000000000001'::uuid, 'c3: the rejected change left the payer as A');

-- ---------------------------------------------------------------------------
-- Criterion 12: the kind constraint
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.bill_events (bill_id, kind)
     select current_setting('test.y_id')::uuid, k
     from unnest(array['bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed',
                       'item_added', 'item_removed', 'item_changed', 'amounts_changed',
                       'link_rotated', 'extras_split_changed',
                       'payer_changed', 'marked_paid', 'unmarked_paid']) as k $$,
  'c12: every existing kind and the three new kinds are accepted');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (current_setting('test.y_id')::uuid, 'paid') $$,
  '23514', null, 'c12: kind ''paid'' is rejected');

select * from finish();
rollback;
