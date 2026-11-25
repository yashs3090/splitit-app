-- pgTAP tests for People you've split with, Task 1 (spec docs/specs/2026-11-24-people-and-invites.md,
-- criteria 1-14, L1 cases P1-P10, L2 cases R1-R5): bill_participants.added, private.my_links,
-- people_i_split_with, add_participant and the new Activity kinds.
--
-- Every assertion filters to the fixture users/bills below (the local DB may hold real data).
-- Fixture ids all start with 7a. Criterion 3 also covers remove_participant and leave_bill, which
-- 20261124091042_membership.sql adds.
--
-- Users: A ..01 'Hana' (host of Y and X), B ..02 'Sam', C ..03 'Cal' (host of W),
--        D ..04 'Dee' (no bills), E ..05 'Eve' (a real user nobody is linked with).
-- Ranking viewers and their people: ..31-..93 (R1-R5); limit test: L ..81 and 201 users
-- 7a000000-0000-0000-0001-000000000001 .. 201.

begin;

create extension if not exists pgtap with schema extensions;

select plan(59);

-- ---------------------------------------------------------------------------
-- Helpers (run as postgres; they set the caller for the security definer functions)
-- ---------------------------------------------------------------------------
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.mk_bill(p_host uuid, p_at timestamptz default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.act(p_host);
  select r.bill_id into v_id from public.create_bill(
    '[{"name":"Item","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":100}]'::jsonb,
    null, 0, 0, 0, 0, 0, 100) as r;
  if p_at is not null then
    update public.bills set created_at = p_at where id = v_id;
  end if;
  return v_id;
end $$;

create function pg_temp.join_as(p_user uuid, p_bill uuid) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  perform public.join_bill((select b.join_code from public.bills as b where b.id = p_bill));
end $$;

create function pg_temp.claim_as(p_user uuid, p_bill uuid, p_on boolean) returns void
language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  perform public.set_claim(
    (select li.id from public.line_items as li where li.bill_id = p_bill order by li.id limit 1), p_on);
end $$;

-- p_target's shared_bills in p_viewer's list, or null when absent.
create function pg_temp.shared(p_viewer uuid, p_target uuid) returns integer language plpgsql as $$
begin
  perform pg_temp.act(p_viewer);
  return (select p.shared_bills from public.people_i_split_with() as p where p.user_id = p_target);
end $$;

create function pg_temp.list_ids(p_viewer uuid) returns setof uuid language plpgsql as $$
begin
  perform pg_temp.act(p_viewer);
  return query select p.user_id from public.people_i_split_with() as p;
end $$;

-- p_viewer's whole list, in the function's order.
create function pg_temp.people(p_viewer uuid)
returns table (user_id uuid, display_name text, venmo_username text, shared_bills integer,
               last_shared_at timestamptz)
language plpgsql as $$
begin
  perform pg_temp.act(p_viewer);
  return query select * from public.people_i_split_with();
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('7a000000-0000-0000-0000-000000000001', 'people-a@test.local', '{"full_name":"Hana"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000002', 'people-b@test.local', '{"full_name":"Sam"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000003', 'people-c@test.local', '{"full_name":"Cal"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000004', 'people-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000005', 'people-e@test.local', '{"full_name":"Eve"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Criterion 1: the column
-- ---------------------------------------------------------------------------
select col_type_is('public', 'bill_participants', 'added', 'boolean', 'c1: added is boolean');
select col_not_null('public', 'bill_participants', 'added', 'c1: added is not null');
select col_default_is('public', 'bill_participants', 'added', 'false', 'c1: added defaults to false');

-- Fixtures: Y (A hosts, Jan 1), B joins Y; X (A hosts, Feb 1); W (C hosts).
select set_config('test.y', pg_temp.mk_bill('7a000000-0000-0000-0000-000000000001', '2026-01-01 12:00+00')::text, true);
select pg_temp.join_as('7a000000-0000-0000-0000-000000000002', current_setting('test.y')::uuid);
select set_config('test.x', pg_temp.mk_bill('7a000000-0000-0000-0000-000000000001', '2026-02-01 12:00+00')::text, true);
select set_config('test.w', pg_temp.mk_bill('7a000000-0000-0000-0000-000000000003')::text, true);

select is(
  (select added from public.bill_participants
   where bill_id = current_setting('test.y')::uuid and user_id = '7a000000-0000-0000-0000-000000000001'),
  false, 'c1: the host row from create_bill has added = false');
select is(
  (select added from public.bill_participants
   where bill_id = current_setting('test.y')::uuid and user_id = '7a000000-0000-0000-0000-000000000002'),
  false, 'c1: a row from join_bill has added = false');

-- ---------------------------------------------------------------------------
-- Criterion 2: grants on bill_participants
-- ---------------------------------------------------------------------------
select table_privs_are('public', 'bill_participants', 'authenticated', array['SELECT'],
  'c2: authenticated has only SELECT on bill_participants');
select table_privs_are('public', 'bill_participants', 'anon', array[]::text[],
  'c2: anon has nothing on bill_participants');

set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ insert into public.bill_participants (bill_id, user_id)
     values (current_setting('test.y')::uuid, '7a000000-0000-0000-0000-000000000004') $$,
  '42501', null, 'c2: a direct insert into bill_participants fails with 42501');
select throws_ok(
  $$ update public.bill_participants set added = false where bill_id = current_setting('test.y')::uuid $$,
  '42501', null, 'c2: a direct update of added fails with 42501');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 3: function privileges
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.people_i_split_with() $$, '42501', null,
  'c3: anon cannot call people_i_split_with');
select throws_ok(
  $$ select public.add_participant(current_setting('test.y')::uuid, '7a000000-0000-0000-0000-000000000002') $$,
  '42501', null, 'c3: anon cannot call add_participant');
select throws_ok(
  $$ select public.remove_participant(current_setting('test.y')::uuid, '7a000000-0000-0000-0000-000000000002') $$,
  '42501', null, 'c3: anon cannot call remove_participant');
select throws_ok($$ select public.leave_bill(current_setting('test.y')::uuid) $$, '42501', null,
  'c3: anon cannot call leave_bill');
reset role;

select ok(
  (select bool_and(p.proacl is not null) and count(*) = 4 from pg_proc as p
   where p.oid in ('public.people_i_split_with()'::regprocedure, 'public.add_participant(uuid,uuid)'::regprocedure,
                   'public.remove_participant(uuid,uuid)'::regprocedure, 'public.leave_bill(uuid)'::regprocedure))
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.oid in ('public.people_i_split_with()'::regprocedure, 'public.add_participant(uuid,uuid)'::regprocedure,
                    'public.remove_participant(uuid,uuid)'::regprocedure, 'public.leave_bill(uuid)'::regprocedure,
                    'private.my_links()'::regprocedure)
      and a.grantee = 0 and a.privilege_type = 'EXECUTE')
  and not has_function_privilege('anon', 'public.people_i_split_with()', 'execute')
  and not has_function_privilege('anon', 'public.add_participant(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.remove_participant(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.leave_bill(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.people_i_split_with()', 'execute')
  and has_function_privilege('authenticated', 'public.add_participant(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.my_links()', 'execute'),
  'c3: public and anon have no EXECUTE on the four functions; authenticated has it; nobody may call my_links');
select ok(
  (select bool_and(prosecdef and proconfig = array['search_path=""']) and count(*) = 4 from pg_proc
   where oid in ('public.people_i_split_with()'::regprocedure, 'public.add_participant(uuid,uuid)'::regprocedure,
                 'public.remove_participant(uuid,uuid)'::regprocedure, 'public.leave_bill(uuid)'::regprocedure)),
  'c3: the four functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- L1 P1, P2; criteria 10, 11
-- ---------------------------------------------------------------------------
select is(
  array[pg_temp.shared('7a000000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000002'),
        pg_temp.shared('7a000000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000001')],
  array[1, 1], 'P1: B joined Y, so A sees B and B sees A with shared_bills 1');

set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000002');
reset role;

select is(
  pg_temp.shared('7a000000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000002'),
  1, 'P2: B added to X with no claims there; A''s row for B still says 1');

select results_eq(
  $$ select user_id::text, added from public.bill_participants
     where bill_id = current_setting('test.x')::uuid and user_id = '7a000000-0000-0000-0000-000000000002' $$,
  $$ values ('7a000000-0000-0000-0000-000000000002'::text, true) $$,
  'c10: add_participant inserts exactly one row for B with added = true');
select results_eq(
  $$ select actor_id::text, details from public.bill_events
     where bill_id = current_setting('test.x')::uuid and kind = 'participant_added' $$,
  $$ values ('7a000000-0000-0000-0000-000000000001'::text, '{"user_id": "7a000000-0000-0000-0000-000000000002"}'::jsonb) $$,
  'c10: exactly one participant_added event, actor A, details {user_id: B}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000002') $$,
  'c11: adding B to X a second time does not raise');
select lives_ok(
  $$ select public.add_participant(current_setting('test.y')::uuid, '7a000000-0000-0000-0000-000000000002') $$,
  'c11: adding B to Y (B joined with the link) does not raise');
reset role;
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x')::uuid and user_id = '7a000000-0000-0000-0000-000000000002')
  + (select count(*)::int from public.bill_events
     where bill_id = current_setting('test.x')::uuid and kind = 'participant_added'),
  2, 'c11: after adding B to X twice, there is still one row and one event');
select is(
  (select count(*)::int from public.bill_events
   where bill_id = current_setting('test.y')::uuid and kind = 'participant_added')
  + (select count(*)::int from public.bill_participants
     where bill_id = current_setting('test.y')::uuid and added),
  0, 'c11: adding a joined participant to Y logs nothing and leaves added = false');

-- ---------------------------------------------------------------------------
-- L1 P4 (C joins X; B was added there and has no claims)
-- ---------------------------------------------------------------------------
select pg_temp.join_as('7a000000-0000-0000-0000-000000000003', current_setting('test.x')::uuid);

select ok(
  pg_temp.shared('7a000000-0000-0000-0000-000000000003', '7a000000-0000-0000-0000-000000000002') is null
  and pg_temp.shared('7a000000-0000-0000-0000-000000000002', '7a000000-0000-0000-0000-000000000003') is null
  and pg_temp.shared('7a000000-0000-0000-0000-000000000003', '7a000000-0000-0000-0000-000000000001') = 1,
  'P4: C''s list has A but not B, and B''s list has no C');
set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.add_participant(current_setting('test.w')::uuid, '7a000000-0000-0000-0000-000000000002') $$,
  '22023', 'not_linked', 'P4: C''s add_participant(W, B) fails with 22023 not_linked');
reset role;

-- ---------------------------------------------------------------------------
-- L1 P3, P5 (B claims a row on X); criterion 7
-- ---------------------------------------------------------------------------
select pg_temp.claim_as('7a000000-0000-0000-0000-000000000002', current_setting('test.x')::uuid, true);

select results_eq(
  $$ select p.shared_bills, p.last_shared_at from pg_temp.people('7a000000-0000-0000-0000-000000000001') as p
     where p.user_id = '7a000000-0000-0000-0000-000000000002' $$,
  $$ select 2, b.created_at from public.bills as b where b.id = current_setting('test.x')::uuid $$,
  'P3: once B claims on X, shared_bills is 2 and last_shared_at is X''s created_at');
select is(
  pg_temp.shared('7a000000-0000-0000-0000-000000000003', '7a000000-0000-0000-0000-000000000002'),
  1, 'P5: C''s list now has B with shared_bills 1');
set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok(
  $$ select public.add_participant(current_setting('test.w')::uuid, '7a000000-0000-0000-0000-000000000002') $$,
  'P5: C''s add_participant(W, B) now succeeds');
reset role;

select ok(
  (select bool_and(p.shared_bills >= 1) and count(*) >= 2
   from pg_temp.people('7a000000-0000-0000-0000-000000000001') as p)
  and (select bool_and(p.shared_bills >= 1) and count(*) >= 1
       from pg_temp.people('7a000000-0000-0000-0000-000000000003') as p),
  'c7: every row in A''s and C''s lists has shared_bills >= 1');

-- ---------------------------------------------------------------------------
-- L1 P6 (B unclaims everything on X), P7, P8; criterion 8
-- ---------------------------------------------------------------------------
select pg_temp.claim_as('7a000000-0000-0000-0000-000000000002', current_setting('test.x')::uuid, false);

select is(
  pg_temp.shared('7a000000-0000-0000-0000-000000000003', '7a000000-0000-0000-0000-000000000002'),
  null, 'P6: after B unclaims on X, C''s list loses B (B is only an unclaimed added row on W)');
select ok(
  not exists (select 1 from pg_temp.list_ids('7a000000-0000-0000-0000-000000000001') as u
              where u = '7a000000-0000-0000-0000-000000000001')
  and not exists (select 1 from pg_temp.list_ids('7a000000-0000-0000-0000-000000000002') as u
                  where u = '7a000000-0000-0000-0000-000000000002')
  and not exists (select 1 from pg_temp.list_ids('7a000000-0000-0000-0000-000000000003') as u
                  where u = '7a000000-0000-0000-0000-000000000003'),
  'P7: nobody''s own id is in their list');
select is(
  (select count(*)::int from pg_temp.list_ids('7a000000-0000-0000-0000-000000000004')),
  0, 'P8: D has no bills, so D''s list is empty');

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select * from public.people_i_split_with() $$, '42501', 'not_allowed',
  'c8: a signed-out call fails with 42501 not_allowed');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 9: every returned id is a profile the caller can already read (RLS)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(
  (select count(*) from public.people_i_split_with()) > 0
  and not exists (select p.user_id from public.people_i_split_with() as p
                  except select pr.id from public.profiles as pr),
  'c9: as A, every listed user_id is readable in profiles');
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(
  (select count(*) from public.people_i_split_with()) > 0
  and not exists (select p.user_id from public.people_i_split_with() as p
                  except select pr.id from public.profiles as pr),
  'c9: as B, every listed user_id is readable in profiles');
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000003","role":"authenticated"}';
select ok(
  (select count(*) from public.people_i_split_with()) > 0
  and not exists (select p.user_id from public.people_i_split_with() as p
                  except select pr.id from public.profiles as pr),
  'c9: as C, every listed user_id is readable in profiles');
reset role;

-- ---------------------------------------------------------------------------
-- Criteria 12 and 13: refused adds change nothing
-- ---------------------------------------------------------------------------
create temp table x_before as
  select (select count(*) from public.bill_participants where bill_id = current_setting('test.x')::uuid) as rows,
         (select count(*) from public.bill_events where bill_id = current_setting('test.x')::uuid) as events;
grant select on x_before to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000004') $$,
  '42501', 'not_allowed', 'c12: a non-host participant (B) gets 42501 not_allowed');
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000005') $$,
  '42501', 'not_allowed', 'c12: a non-participant (D) gets 42501 not_allowed');
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.add_participant('7a0000ff-0000-0000-0000-000000000000', '7a000000-0000-0000-0000-000000000003') $$,
  '42501', 'not_allowed', 'c12: a bill id that doesn''t exist gets 42501 not_allowed');
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000004') $$,
  '42501', 'not_allowed', 'c12: a signed-out call gets 42501 not_allowed');

set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000005') $$,
  '22023', 'not_linked', 'c13: an unlinked real user (E) gets 22023 not_linked');
select throws_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a0000ee-0000-0000-0000-000000000000') $$,
  '22023', 'not_linked', 'c13: a random uuid that isn''t a user gets the same 22023 not_linked');
select lives_ok(
  $$ select public.add_participant(current_setting('test.x')::uuid, '7a000000-0000-0000-0000-000000000001') $$,
  'c13: the host adding their own id is a no-op');
reset role;

select results_eq(
  $$ select (select count(*) from public.bill_participants where bill_id = current_setting('test.x')::uuid),
            (select count(*) from public.bill_events where bill_id = current_setting('test.x')::uuid) $$,
  $$ select rows, events from x_before $$,
  'c12/c13: none of the refused or no-op adds inserted a row or logged an event');

-- ---------------------------------------------------------------------------
-- Criterion 14: the kind constraint
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.bill_events (bill_id, kind)
     select current_setting('test.w')::uuid, k
     from unnest(array['bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed',
                       'item_added', 'item_removed', 'item_changed', 'amounts_changed',
                       'link_rotated', 'extras_split_changed', 'payer_changed', 'marked_paid',
                       'unmarked_paid', 'participant_added', 'participant_removed', 'left']) as k $$,
  'c14: every existing kind plus participant_added, participant_removed and left is accepted');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (current_setting('test.w')::uuid, 'paid') $$,
  '23514', null, 'c14: kind ''paid'' is still rejected');

-- ---------------------------------------------------------------------------
-- L2 ranking, R1-R5 (each case has its own viewer, so lists hold only that case's people)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('7a000000-0000-0000-0000-000000000031', 'people-v1@test.local', '{"full_name":"V1"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000032', 'people-r1s@test.local', '{"full_name":"Sam"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000033', 'people-r1a@test.local', '{"full_name":"Ali"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000041', 'people-v2@test.local', '{"full_name":"V2"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000042', 'people-r2s@test.local', '{"full_name":"Sam"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000043', 'people-r2a@test.local', '{"full_name":"Ali"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000051', 'people-v3@test.local', '{"full_name":"V3"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000052', 'people-r3s@test.local', '{"full_name":"sam"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000053', 'people-r3a@test.local', '{"full_name":"Ali"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000091', 'people-v6@test.local', '{"full_name":"V6"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000092', 'people-r3bs@test.local', '{"full_name":"Sam"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000093', 'people-r3ba@test.local', '{"full_name":"ali"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000061', 'people-v4@test.local', '{"full_name":"V4"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000062', 'people-r4n@test.local', '{}'::jsonb),
  ('7a000000-0000-0000-0000-000000000063', 'people-r4z@test.local', '{"full_name":"Zed"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000071', 'people-v5@test.local', '{"full_name":"V5"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000073', 'people-r5b@test.local', '{"full_name":"Kim"}'::jsonb),
  ('7a000000-0000-0000-0000-000000000072', 'people-r5a@test.local', '{"full_name":"Kim"}'::jsonb);

do $$
declare b1 uuid; b2 uuid; b3 uuid;
begin
  -- R1: Sam on 3 bills, Ali on 1.
  b1 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000031');
  b2 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000031');
  b3 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000031');
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000032', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000032', b2);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000032', b3);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000033', b1);
  -- R2: both on 2 bills; Ali's latest is newer.
  b1 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000041', '2026-01-01 12:00+00');
  b2 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000041', '2026-01-02 12:00+00');
  b3 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000041', '2026-01-03 12:00+00');
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000042', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000042', b2);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000043', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000043', b3);
  -- R3: both on the same 2 bills; "sam" and "Ali".
  b1 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000051');
  b2 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000051');
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000052', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000052', b2);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000053', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000053', b2);
  -- R3b: same, "Sam" and "ali" (a plain byte comparison would put "Sam" first).
  b1 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000091');
  b2 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000091');
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000092', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000092', b2);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000093', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000093', b2);
  -- R4: one named, one with no name (the unnamed one has the lower id).
  b1 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000061');
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000062', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000063', b1);
  -- R5: everything equal (the higher id joins first).
  b1 := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000071');
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000073', b1);
  perform pg_temp.join_as('7a000000-0000-0000-0000-000000000072', b1);
end $$;

select results_eq(
  $$ select u::text from pg_temp.list_ids('7a000000-0000-0000-0000-000000000031') as u $$,
  $$ values ('7a000000-0000-0000-0000-000000000032'), ('7a000000-0000-0000-0000-000000000033') $$,
  'R1: Sam (3 bills) before Ali (1 bill)');
select results_eq(
  $$ select u::text from pg_temp.list_ids('7a000000-0000-0000-0000-000000000041') as u $$,
  $$ values ('7a000000-0000-0000-0000-000000000043'), ('7a000000-0000-0000-0000-000000000042') $$,
  'R2: both 2 bills; Ali (newer latest bill) before Sam');
select results_eq(
  $$ select u::text from pg_temp.list_ids('7a000000-0000-0000-0000-000000000051') as u $$,
  $$ values ('7a000000-0000-0000-0000-000000000053'), ('7a000000-0000-0000-0000-000000000052') $$,
  'R3: same counts and date; "Ali" before "sam"');
select results_eq(
  $$ select u::text from pg_temp.list_ids('7a000000-0000-0000-0000-000000000091') as u $$,
  $$ values ('7a000000-0000-0000-0000-000000000093'), ('7a000000-0000-0000-0000-000000000092') $$,
  'R3 (case-insensitive): "ali" before "Sam"');
select results_eq(
  $$ select u::text from pg_temp.list_ids('7a000000-0000-0000-0000-000000000061') as u $$,
  $$ values ('7a000000-0000-0000-0000-000000000063'), ('7a000000-0000-0000-0000-000000000062') $$,
  'R4: the named person first, the one with no name last');
select results_eq(
  $$ select u::text from pg_temp.list_ids('7a000000-0000-0000-0000-000000000071') as u $$,
  $$ values ('7a000000-0000-0000-0000-000000000072'), ('7a000000-0000-0000-0000-000000000073') $$,
  'R5: everything equal; the lower user_id first');

-- ---------------------------------------------------------------------------
-- Criterion 6: the 200-row limit
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values ('7a000000-0000-0000-0000-000000000081', 'people-lim@test.local', '{"full_name":"Lim host"}'::jsonb);
insert into auth.users (id, email, raw_user_meta_data)
select ('7a000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid,
       'people-lim-' || i || '@test.local',
       jsonb_build_object('full_name', 'Lim ' || lpad(i::text, 3, '0'))
from generate_series(1, 201) as i;

do $$
declare b uuid := pg_temp.mk_bill('7a000000-0000-0000-0000-000000000081');
begin
  for i in 1..201 loop
    perform pg_temp.join_as(('7a000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid, b);
  end loop;
end $$;

select is(
  (select count(*)::int from pg_temp.list_ids('7a000000-0000-0000-0000-000000000081')),
  200, 'c6: with 201 linked people, the list returns exactly 200 rows');
select ok(
  not exists (select 1 from pg_temp.list_ids('7a000000-0000-0000-0000-000000000081') as u
              where u = '7a000000-0000-0000-0001-000000000201')
  and exists (select 1 from pg_temp.list_ids('7a000000-0000-0000-0000-000000000081') as u
              where u = '7a000000-0000-0000-0001-000000000200'),
  'c6: the one dropped is the lowest-ranked ("Lim 201")');

-- ---------------------------------------------------------------------------
-- L1 P9: B leaves Y
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$ select public.leave_bill(current_setting('test.y')::uuid) $$, 'P9: B leaves Y');
reset role;
select is(
  pg_temp.shared('7a000000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000002'),
  null, 'P9: A''s list no longer has B (B''s only other bill is X, added with no claims)');

-- ---------------------------------------------------------------------------
-- L1 P10 (decision PI-R-1): B, added to X with no claims, opens X's link
-- ---------------------------------------------------------------------------
select pg_temp.join_as('7a000000-0000-0000-0000-000000000002', current_setting('test.x')::uuid);

select results_eq(
  $$ select bp.added,
            (select count(*)::int from public.bill_events as e
             where e.bill_id = current_setting('test.x')::uuid and e.kind = 'joined'
               and e.actor_id = '7a000000-0000-0000-0000-000000000002')
     from public.bill_participants as bp
     where bp.bill_id = current_setting('test.x')::uuid and bp.user_id = '7a000000-0000-0000-0000-000000000002' $$,
  $$ values (false, 1) $$,
  'P10: joining X with the link sets B''s added to false and logs one joined event');
select is(
  pg_temp.shared('7a000000-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000002'),
  1, 'P10: A''s list has B again through X, with no claim by B');

select pg_temp.join_as('7a000000-0000-0000-0000-000000000002', current_setting('test.x')::uuid);
select is(
  (select count(*)::int from public.bill_events
   where bill_id = current_setting('test.x')::uuid and kind = 'joined'
     and actor_id = '7a000000-0000-0000-0000-000000000002'),
  1, 'P10: opening the link again changes nothing and logs no second joined event');

select * from finish();
rollback;
