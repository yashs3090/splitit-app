-- pgTAP tests for People you've split with, Task 2 (spec docs/specs/2026-11-24-people-and-invites.md,
-- criteria 15-20, L3 cases M1-M8): remove_participant, leave_bill and the delete broadcast.
-- Criterion 21 (the lock that keeps a simultaneous claim from being cascaded away) is a review
-- check: see the header of supabase/migrations/20261124091042_membership.sql.
--
-- Every assertion filters to the fixture users/bills below (the local DB may hold real data).
-- Fixture ids all start with 7b.
--
-- Users: H ..01 'Hana' (host of X and Z), P ..02 'Pat' (payer of X, 0 claims),
--        Ada ..03 (added to X; linked to H through Z), Joe ..04 (joined X with the link),
--        Cy ..05 (claims Burger and unit 1 of "Beer x2"), Bea ..06 (claims unit 2 of "Beer x2"), Mo ..07 (a mark, 0 claims),
--        Out ..08 (not on X).
-- Bill X: Burger 1500, Beer x2 (700 + 700); total 2900. Bill Z: Item 100.

begin;

create extension if not exists pgtap with schema extensions;

select plan(41);

-- ---------------------------------------------------------------------------
-- Helpers (run as postgres; they set the caller for the security definer functions)
-- ---------------------------------------------------------------------------
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.join_as(p_user uuid, p_bill uuid) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  perform public.join_bill((select b.join_code from public.bills as b where b.id = p_bill));
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('7b000000-0000-0000-0000-000000000001', 'members-h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000002', 'members-p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000003', 'members-ada@test.local', '{"full_name":"Ada"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000004', 'members-joe@test.local', '{"full_name":"Joe"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000005', 'members-cy@test.local', '{"full_name":"Cy"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000006', 'members-bea@test.local', '{"full_name":"Bea"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000007', 'members-mo@test.local', '{"full_name":"Mo"}'::jsonb),
  ('7b000000-0000-0000-0000-000000000008', 'members-out@test.local', '{"full_name":"Out"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  perform pg_temp.act('7b000000-0000-0000-0000-000000000001');
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Beer","note":null,"group_position":1,"unit_index":0,"group_size":2,"total_cents":700},
    {"name":"Beer","note":null,"group_position":1,"unit_index":1,"group_size":2,"total_cents":700}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 2900);
  perform set_config('test.x', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
  select * into r from public.create_bill(
    '[{"name":"Item","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":100}]'::jsonb,
    null, 0, 0, 0, 0, 0, 100);
  perform set_config('test.z', r.bill_id::text, true);
end $$;

select pg_temp.join_as('7b000000-0000-0000-0000-000000000003', current_setting('test.z')::uuid);
select pg_temp.join_as('7b000000-0000-0000-0000-000000000002', current_setting('test.x')::uuid);
select pg_temp.join_as('7b000000-0000-0000-0000-000000000004', current_setting('test.x')::uuid);
select pg_temp.join_as('7b000000-0000-0000-0000-000000000005', current_setting('test.x')::uuid);
select pg_temp.join_as('7b000000-0000-0000-0000-000000000006', current_setting('test.x')::uuid);
select pg_temp.join_as('7b000000-0000-0000-0000-000000000007', current_setting('test.x')::uuid);

do $$
begin
  perform pg_temp.act('7b000000-0000-0000-0000-000000000001');
  perform public.add_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000003');
  perform public.set_payer(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000002', 0);
  perform pg_temp.act('7b000000-0000-0000-0000-000000000005');
  perform public.set_claim((select id from public.line_items
                            where bill_id = current_setting('test.x')::uuid and name = 'Burger'), true);
  perform pg_temp.act('7b000000-0000-0000-0000-000000000006');
  perform public.set_claim((select id from public.line_items
                            where bill_id = current_setting('test.x')::uuid and name = 'Beer' and unit_index = 1), true);
end $$;

-- M7: a mark with 0 claims, through the real function. Cy claims unit 1 of "Beer x2" so every
-- item is claimed and the bill is complete; then Mo (0 claims) marks paid. mark_paid accepts
-- this once the bill is complete (decision PI-M-1); only the screen hides the button.
do $$
begin
  perform pg_temp.act('7b000000-0000-0000-0000-000000000005');
  perform public.set_claim((select id from public.line_items
                            where bill_id = current_setting('test.x')::uuid and name = 'Beer' and unit_index = 0), true);
  perform pg_temp.act('7b000000-0000-0000-0000-000000000007');
  perform public.mark_paid(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000002', 500);
end $$;

select ok(
  not has_function_privilege('authenticated', 'private.is_removable(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'private.is_removable(uuid,uuid)', 'execute'),
  'private.is_removable is not executable by any client role');

-- Snapshot for criterion 18.
create temp table x_parts as
  select user_id, added, settled_at, settled_cents from public.bill_participants
  where bill_id = current_setting('test.x')::uuid;
create temp table x_claims as
  select line_item_id, user_id, parts from public.claims where bill_id = current_setting('test.x')::uuid;
create temp table x_bill as
  select payer_id from public.bills where id = current_setting('test.x')::uuid;
create temp table x_events as
  select id from public.bill_events where bill_id = current_setting('test.x')::uuid;

-- ---------------------------------------------------------------------------
-- Criterion 17: who may call
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000003') $$,
  '42501', 'not_allowed', 'c17: remove by a non-host participant (Joe) fails with 42501 not_allowed');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000008","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000003') $$,
  '42501', 'not_allowed', 'c17: remove by a non-participant fails with 42501 not_allowed');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_participant('7b0000ff-0000-0000-0000-000000000000', '7b000000-0000-0000-0000-000000000003') $$,
  '42501', 'not_allowed', 'c17: remove on a missing bill fails with 42501 not_allowed');
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000003') $$,
  '42501', 'not_allowed', 'c17: remove while signed out fails with 42501 not_allowed');
select throws_ok(
  $$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '42501', 'not_allowed', 'c17: leave while signed out fails with 42501 not_allowed');

-- ---------------------------------------------------------------------------
-- L3 refusals, remove (as the host H)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000001') $$,
  '22023', 'cannot_remove', 'M1 remove: the host can''t be removed (22023 cannot_remove)');
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000002') $$,
  '22023', 'cannot_remove', 'M2 remove: the payer (0 claims) can''t be removed');
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000005') $$,
  '22023', 'cannot_remove', 'M5 remove: someone with 1 claim can''t be removed');
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000006') $$,
  '22023', 'cannot_remove', 'M6 remove: someone with a claim on unit 2 of "Beer x2" can''t be removed');
select throws_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000007') $$,
  '22023', 'cannot_remove', 'M7 remove: someone with a mark (0 claims) can''t be removed');
select lives_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000008') $$,
  'M8 remove: removing a non-participant is a no-op');

-- ---------------------------------------------------------------------------
-- L3 refusals, leave (as the target)
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '22023', 'cannot_leave', 'M1 leave: the host can''t leave (22023 cannot_leave)');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '22023', 'cannot_leave', 'M2 leave: the payer can''t leave');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '22023', 'cannot_leave', 'M5 leave: someone with 1 claim can''t leave');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000006","role":"authenticated"}';
select throws_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '22023', 'cannot_leave', 'M6 leave: someone with a claim on unit 2 of "Beer x2" can''t leave');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000007","role":"authenticated"}';
select throws_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '22023', 'cannot_leave', 'M7 leave: someone with a mark can''t leave');
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000008","role":"authenticated"}';
select throws_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  '42501', 'not_allowed', 'M8 leave: a non-participant gets 42501 not_allowed');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 18: refused and no-op calls changed nothing
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select user_id, added, settled_at, settled_cents from public.bill_participants
     where bill_id = current_setting('test.x')::uuid order by user_id $$,
  $$ select * from x_parts order by user_id $$,
  'c18: every participant row and mark on X is as before');
select results_eq(
  $$ select line_item_id, user_id, parts from public.claims
     where bill_id = current_setting('test.x')::uuid order by 1, 2 $$,
  $$ select * from x_claims order by 1, 2 $$,
  'c18: every claim on X is as before');
select results_eq(
  $$ select payer_id from public.bills where id = current_setting('test.x')::uuid $$,
  $$ select payer_id from x_bill $$,
  'c18: the payer is unchanged');
select is(
  (select count(*)::int from public.bill_events
   where bill_id = current_setting('test.x')::uuid and id not in (select id from x_events)),
  0, 'c18: no event was logged');

-- ---------------------------------------------------------------------------
-- M3, M4 remove (as H); criterion 16; criterion 20 (the broadcast)
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic = 'bill:' || current_setting('test.x');

set local role authenticated;
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000003') $$,
  'M3 remove: the host removes Ada (added, 0 claims, no mark, not payer)');
reset role;
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x')::uuid and user_id = '7b000000-0000-0000-0000-000000000003'),
  0, 'M3 remove: Ada''s row is gone');
select results_eq(
  $$ select kind, actor_id::text, details from public.bill_events
     where bill_id = current_setting('test.x')::uuid and id not in (select id from x_events) $$,
  $$ values ('participant_removed'::text, '7b000000-0000-0000-0000-000000000001'::text,
             '{"user_id": "7b000000-0000-0000-0000-000000000003"}'::jsonb) $$,
  'c16: exactly one event, participant_removed by H with {user_id: Ada} (no unclaimed, no payer_changed)');
select is(
  (select count(*)::int from realtime.messages
   where topic = 'bill:' || current_setting('test.x') and payload ->> 't' = 'bill_participants'),
  1, 'c20: the remove sent exactly one bill_participants broadcast on bill:<X>');
insert into x_events select id from public.bill_events where bill_id = current_setting('test.x')::uuid
  and id not in (select id from x_events);

set local role authenticated;
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.remove_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000004') $$,
  'M4 remove: the host removes Joe (joined by link, 0 claims, no mark, not payer)');
reset role;
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x')::uuid and user_id = '7b000000-0000-0000-0000-000000000004'),
  0, 'M4 remove: Joe''s row is gone');
select results_eq(
  $$ select kind, actor_id::text, details from public.bill_events
     where bill_id = current_setting('test.x')::uuid and id not in (select id from x_events) $$,
  $$ values ('participant_removed'::text, '7b000000-0000-0000-0000-000000000001'::text,
             '{"user_id": "7b000000-0000-0000-0000-000000000004"}'::jsonb) $$,
  'c16: exactly one participant_removed by H with {user_id: Joe}');
insert into x_events select id from public.bill_events where bill_id = current_setting('test.x')::uuid
  and id not in (select id from x_events);

-- ---------------------------------------------------------------------------
-- M3, M4 leave (as the target); criterion 16
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.act('7b000000-0000-0000-0000-000000000001');
  perform public.add_participant(current_setting('test.x')::uuid, '7b000000-0000-0000-0000-000000000003');
end $$;
insert into x_events select id from public.bill_events where bill_id = current_setting('test.x')::uuid
  and id not in (select id from x_events);

set local role authenticated;
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  'M3 leave: Ada (added again, 0 claims) leaves');
reset role;
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x')::uuid and user_id = '7b000000-0000-0000-0000-000000000003'),
  0, 'M3 leave: Ada''s row is gone');
select results_eq(
  $$ select kind, actor_id::text, details from public.bill_events
     where bill_id = current_setting('test.x')::uuid and id not in (select id from x_events) $$,
  $$ values ('left'::text, '7b000000-0000-0000-0000-000000000003'::text, '{}'::jsonb) $$,
  'c16: exactly one event, left by Ada with {}');
insert into x_events select id from public.bill_events where bill_id = current_setting('test.x')::uuid
  and id not in (select id from x_events);

select pg_temp.join_as('7b000000-0000-0000-0000-000000000004', current_setting('test.x')::uuid);
insert into x_events select id from public.bill_events where bill_id = current_setting('test.x')::uuid
  and id not in (select id from x_events);

set local role authenticated;
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000004","role":"authenticated"}';
select lives_ok($$ select public.leave_bill(current_setting('test.x')::uuid) $$,
  'M4 leave: Joe (joined again by link, 0 claims) leaves');
reset role;
select is(
  (select count(*)::int from public.bill_participants
   where bill_id = current_setting('test.x')::uuid and user_id = '7b000000-0000-0000-0000-000000000004'),
  0, 'M4 leave: Joe''s row is gone');
select results_eq(
  $$ select kind, actor_id::text, details from public.bill_events
     where bill_id = current_setting('test.x')::uuid and id not in (select id from x_events) $$,
  $$ values ('left'::text, '7b000000-0000-0000-0000-000000000004'::text, '{}'::jsonb) $$,
  'c16: exactly one event, left by Joe with {}');
insert into x_events select id from public.bill_events where bill_id = current_setting('test.x')::uuid
  and id not in (select id from x_events);

-- ---------------------------------------------------------------------------
-- Criterion 19: after leaving, Joe can read nothing of X; the link brings him back
-- ---------------------------------------------------------------------------
grant select on x_events to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"7b000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is(
  (select count(*)::int from public.bills where id = current_setting('test.x')::uuid)
  + (select count(*)::int from public.line_items where bill_id = current_setting('test.x')::uuid)
  + (select count(*)::int from public.bill_participants where bill_id = current_setting('test.x')::uuid)
  + (select count(*)::int from public.claims where bill_id = current_setting('test.x')::uuid)
  + (select count(*)::int from public.bill_events where bill_id = current_setting('test.x')::uuid),
  0, 'c19: after leaving, Joe selects 0 rows of X from bills, line_items, bill_participants, claims, bill_events');
select lives_ok($$ select public.join_bill(current_setting('test.x_code')) $$,
  'c19: join_bill with X''s code puts Joe back');
reset role;
select results_eq(
  $$ select kind, actor_id::text from public.bill_events
     where bill_id = current_setting('test.x')::uuid and id not in (select id from x_events) $$,
  $$ values ('joined'::text, '7b000000-0000-0000-0000-000000000004'::text) $$,
  'c19: rejoining logs exactly one joined event');

-- ---------------------------------------------------------------------------
-- Criterion 20: the delete broadcast trigger
-- ---------------------------------------------------------------------------
select trigger_is('public', 'bill_participants', 'bill_participants_broadcast_delete',
  'private', 'broadcast_bill_change', 'c20: bill_participants_broadcast_delete runs private.broadcast_bill_change');
select ok(
  (select tgtype & 1 = 0          -- statement level
          and tgtype & 2 = 0      -- after
          and tgtype & 8 <> 0     -- delete
          and tgtype & (4 | 16) = 0
          and tgoldtable = 'old_rows'
   from pg_trigger
   where tgrelid = 'public.bill_participants'::regclass and tgname = 'bill_participants_broadcast_delete'),
  'c20: the trigger is AFTER DELETE ... FOR EACH STATEMENT, referencing old table as old_rows');
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.bill_participants'::regclass
          and tgname = 'bill_participants_broadcast_insert')
  and exists (select 1 from pg_trigger where tgrelid = 'public.bill_participants'::regclass
              and tgname = 'bill_participants_broadcast_update'),
  'c20: the insert and update broadcast triggers are still there');

select * from finish();
rollback;
